import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type { Id } from "@bots/convex/dataModel";
import { LINK_CLOSE } from "@bots/protocol";
import { WebSocket, WebSocketServer } from "ws";
import { resolveIdentity, type AuthMode } from "./auth.ts";
import type { Link } from "./link.ts";
import type { LogFields } from "./log.ts";

const SCREEN_PATH = /^\/screens\/([A-Za-z0-9_-]{1,64})$/;
const MAX_VIEWER_MESSAGE_BYTES = 64 * 1024;
// A viewer that falls this far behind is gone or too slow, and holding more would only cost the orchestrator memory.
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;

function reject(socket: Duplex, status: number): void {
  socket.end(`HTTP/1.1 ${status} ${status === 403 ? "Forbidden" : "Not Found"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

// Tailscale identity arrives on every request, whichever page sent it, and a browser lets any site open a WebSocket.
// So without this check, any site that a user visits could watch that user's screens.
export function isSameOrigin(headers: IncomingMessage["headers"]): boolean {
  const { origin, host } = headers;
  if (origin === undefined || host === undefined || !URL.canParse(origin)) {
    return false;
  }
  return new URL(origin).host === host;
}

function relay(viewer: WebSocket, computer: WebSocket): void {
  const pipe = (from: WebSocket, to: WebSocket) => {
    from.on("message", (data: Buffer, isBinary: boolean) => {
      if (to.readyState !== WebSocket.OPEN) {
        return;
      }
      if (to.bufferedAmount > MAX_BUFFERED_BYTES) {
        to.terminate();
        return;
      }
      to.send(data, { binary: isBinary });
    });
    from.on("close", () => to.close());
    from.on("error", () => to.terminate());
  };
  pipe(viewer, computer);
  pipe(computer, viewer);
}

export function attachScreens(args: {
  server: Pick<Server, "on">;
  authMode: AuthMode;
  link: Pick<Link, "openStream">;
  ownerForViewer: (botId: string, viewerSubject: string) => Promise<{ ownerId: Id<"users"> } | null>;
  log: (fields: LogFields) => void;
}): void {
  const { server, authMode, link, ownerForViewer, log } = args;
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_VIEWER_MESSAGE_BYTES });

  async function handle(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const path = new URL(request.url ?? "/", "http://unused").pathname;
    const match = SCREEN_PATH.exec(path);
    if (match === null) {
      reject(socket, 404);
      return;
    }
    const botId = match[1] as string;
    if (!isSameOrigin(request.headers)) {
      log({ level: "warn", event: "screen-rejected", reason: "cross-origin" });
      reject(socket, 403);
      return;
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (typeof value === "string") {
        headers.set(name, value);
      }
    }
    const identity = resolveIdentity({ mode: authMode, headers });
    if (identity.kind !== "ok") {
      log({ level: "warn", event: "screen-rejected", reason: identity.reason });
      reject(socket, 403);
      return;
    }
    const owner = await ownerForViewer(botId, identity.identity.subject);
    if (owner === null) {
      log({ level: "warn", event: "screen-rejected", reason: "not-the-owner", subject: identity.identity.subject });
      reject(socket, 403);
      return;
    }
    sockets.handleUpgrade(request, socket, head, (viewer) => {
      // Input that arrives before the computer attaches would be lost, so the relay starts only once both ends exist.
      viewer.pause();
      link
        .openStream({ ownerId: owner.ownerId, botId })
        .then((computer) => {
          if (typeof computer === "string") {
            // A paused socket cannot finish a close handshake, so the viewer would hang for the close timeout.
            viewer.resume();
            viewer.close(computer === "too-many" ? LINK_CLOSE.tooManyStreams : LINK_CLOSE.noComputer, computer);
            return;
          }
          if (viewer.readyState !== WebSocket.OPEN) {
            computer.close();
            return;
          }
          relay(viewer, computer);
          viewer.resume();
          log({ level: "info", event: "screen-opened", botId });
        })
        .catch((error: unknown) => {
          log({ level: "error", event: "screen-failed", message: error instanceof Error ? error.message : "unknown error" });
          viewer.close(LINK_CLOSE.internalError);
        });
    });
  }

  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    handle(request, socket, head).catch((error: unknown) => {
      log({ level: "error", event: "screen-failed", message: error instanceof Error ? error.message : "unknown error" });
      reject(socket, 403);
    });
  });
}
