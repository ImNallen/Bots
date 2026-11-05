import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type { Id } from "@bots/convex/dataModel";
import { LINK_CLOSE, MAX_INPUT_MESSAGE_BYTES, browserInputEvent, parseJsonMessage } from "@bots/protocol";
import { WebSocket, WebSocketServer } from "ws";
import { resolveIdentity, type AuthMode } from "./auth.ts";
import type { Link } from "./link.ts";
import type { LogFields } from "./log.ts";

const SCREEN_PATH = /^\/screens\/([A-Za-z0-9_-]{1,64})(\/input)?$/;
const TAKEOVER_CHECK_MS = 5000;
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
    from.on("error", () => {
      from.terminate();
      to.terminate();
    });
  };
  pipe(viewer, computer);
  pipe(computer, viewer);
}

export function attachScreens(args: {
  server: Pick<Server, "on">;
  authMode: AuthMode;
  link: Pick<Link, "openStream" | "sendInput">;
  ownerForViewer: (botId: string, viewerSubject: string) => Promise<{ ownerId: Id<"users">; takeoverUntil: number } | null>;
  log: (fields: LogFields) => void;
}): void {
  const { server, authMode, link, ownerForViewer, log } = args;
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_VIEWER_MESSAGE_BYTES });
  const inputSockets = new WebSocketServer({ noServer: true, maxPayload: MAX_INPUT_MESSAGE_BYTES });

  // Input goes to one bot's page through CDP, so it cannot reach another bot's window whatever X focus does.
  // A message can hold a password, so nothing here logs its content.
  function serveInput(args: { socket: WebSocket; ownerId: Id<"users">; botId: string; subject: string }): void {
    const { socket, ownerId, botId, subject } = args;
    socket.on("error", (error) => {
      log({ level: "warn", event: "screen-input-socket-error", message: error.message });
      socket.terminate();
    });
    socket.on("message", (raw: Buffer, isBinary: boolean) => {
      const event = isBinary ? null : parseJsonMessage({ raw: raw.toString("utf8"), schema: browserInputEvent });
      if (event === null) {
        log({ level: "warn", event: "screen-input-rejected", reason: "invalid-message" });
        socket.close(LINK_CLOSE.invalidMessage);
        return;
      }
      if (!link.sendInput({ ownerId, botId, event })) {
        socket.close(LINK_CLOSE.noComputer);
      }
    });
    const check = setInterval(() => {
      ownerForViewer(botId, subject)
        .then((owner) => {
          if (owner === null || owner.takeoverUntil <= Date.now()) {
            socket.close(LINK_CLOSE.takeoverEnded);
          }
        })
        .catch(() => {});
    }, TAKEOVER_CHECK_MS);
    socket.once("close", () => clearInterval(check));
  }

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
    if (match[2] !== undefined) {
      if (owner.takeoverUntil <= Date.now()) {
        log({ level: "warn", event: "screen-rejected", reason: "not-taken-over" });
        reject(socket, 403);
        return;
      }
      inputSockets.handleUpgrade(request, socket, head, (input) => {
        serveInput({ socket: input, ownerId: owner.ownerId, botId, subject: identity.identity.subject });
      });
      return;
    }
    sockets.handleUpgrade(request, socket, head, (viewer) => {
      // An unhandled error here would stop the whole orchestrator, so a bad frame from one viewer must end only that viewer.
      viewer.on("error", (error) => {
        log({ level: "warn", event: "screen-viewer-error", message: error.message });
        viewer.terminate();
      });
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
    // Node removes its own handler before this event, and the checks above wait on Convex, so a client can reset during them.
    socket.on("error", (error) => {
      log({ level: "warn", event: "screen-socket-error", message: error.message });
    });
    handle(request, socket, head).catch((error: unknown) => {
      log({ level: "error", event: "screen-failed", message: error instanceof Error ? error.message : "unknown error" });
      reject(socket, 403);
    });
  });
}
