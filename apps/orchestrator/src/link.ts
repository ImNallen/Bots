import { randomUUID } from "node:crypto";
import type { Id } from "@bots/convex/dataModel";
import {
  LINK_CLOSE,
  MAX_COMPUTER_MESSAGE_BYTES,
  TOOLS_BEFORE_ANNOUNCEMENT,
  capText,
  computerMessage,
  parseJsonMessage,
  type Browsing,
  type OrchestratorMessage,
  type StreamMode,
  type ToolInvocation,
  type ToolResult,
} from "@bots/protocol";
import { WebSocket, WebSocketServer } from "ws";
import type { LogFields } from "./log.ts";

const HELLO_TIMEOUT_MS = 5000;
const PING_INTERVAL_MS = 10_000;
const CANCEL_GRACE_MS = 10_000;
// computerd enforces each tool's own timeout, so this only catches a computer that stops answering while still connected.
const RESPONSE_MARGIN_MS = 60_000;
const FILE_TOOL_DEADLINE_MS = 60_000;
const MAX_ISSUED_PER_SOCKET = 4096;
const STREAM_ATTACH_TIMEOUT_MS = 10_000;
const MAX_STREAMS_PER_OWNER = 8;

export type Computer = { computerId: Id<"computers">; ownerId: Id<"users"> };

export type LinkOutcome =
  | ToolResult
  | { outcome: "unavailable"; output: string; truncated: false };

export type Link = {
  isConnected: (ownerId: Id<"users">) => boolean;
  openStream: (args: { ownerId: Id<"users">; botId: string; mode: StreamMode }) => Promise<WebSocket | "no-computer" | "too-many">;
  disconnect: (ownerId: Id<"users">) => void;
  call: (args: {
    ownerId: Id<"users">;
    callId: string;
    botId: string;
    tool: ToolInvocation;
    browsing: Browsing | undefined;
    lost: AbortSignal;
    cancel: AbortSignal;
  }) => Promise<LinkOutcome>;
  sendBrowsingEnd: (args: { ownerId: Id<"users">; botId: string; browsing: Browsing }) => void;
};

type Connection = {
  socket: WebSocket;
  computer: Computer;
  // The tools that this computerd named in its hello. A call for any other tool is never sent, because computerd would close the link
  // on it, and the link would send it again at every reconnect.
  accepts: ReadonlySet<string>;
  issued: Set<string>;
  waiters: Map<string, Set<(result: ToolResult) => void>>;
  onDrop: Set<(closeCode: number | undefined) => void>;
};

type SocketState =
  | { kind: "awaitingHello" }
  | { kind: "authenticating" }
  | { kind: "ready"; connection: Connection }
  | { kind: "stream" };

type PendingStream = { ownerId: Id<"users">; attach: (socket: WebSocket) => void };

type Step =
  | { kind: "result"; result: ToolResult }
  | { kind: "retry" }
  | { kind: "lost" }
  | { kind: "gaveUp" };

function responseDeadlineMs(tool: ToolInvocation): number {
  const toolMs = tool.name === "shell" ? tool.args.timeoutSeconds * 1000 : FILE_TOOL_DEADLINE_MS;
  return toolMs + RESPONSE_MARGIN_MS;
}

const UNAVAILABLE_OUTPUT =
  "No computer answered in time, so the outcome is unknown. The call may not have run, or it may have run without its result arriving.";
export const OLDER_COMPUTERD_OUTPUT =
  "This computer runs an older computerd that does not have this tool, so the call did not run. computerd updates itself when this bot's owner has no run, so the tool works in a later conversation.";
const CANCELLED_UNREACHABLE_OUTPUT =
  "The call was cancelled while the computer could not be reached. It may have run, and it may still be running.";

export function startLink(args: {
  host: string;
  port: number;
  computerWaitMs: number;
  authenticate: (token: string) => Promise<Computer | null>;
  log: (fields: LogFields) => void;
}): Link {
  const { log } = args;
  const connections = new Map<Id<"users">, Connection>();
  const onConnect = new Set<() => void>();
  const pendingStreams = new Map<string, PendingStream>();
  const openStreams = new Map<Id<"users">, number>();

  function dropConnection(connection: Connection, closeCode?: number): void {
    if (connections.get(connection.computer.ownerId) === connection) {
      connections.delete(connection.computer.ownerId);
    }
    for (const notify of connection.onDrop) {
      notify(closeCode);
    }
    connection.onDrop.clear();
  }

  function addConnection(socket: WebSocket, computer: Computer, accepts: ReadonlySet<string>): Connection {
    const previous = connections.get(computer.ownerId);
    if (previous !== undefined) {
      dropConnection(previous);
      previous.socket.close(LINK_CLOSE.replaced);
      log({ level: "info", event: "computer-replaced", computerId: computer.computerId });
    }
    const connection: Connection = { socket, computer, accepts, issued: new Set(), waiters: new Map(), onDrop: new Set() };
    connections.set(computer.ownerId, connection);
    for (const notify of onConnect) {
      notify();
    }
    return connection;
  }

  function send(socket: WebSocket, message: OrchestratorMessage): void {
    socket.send(JSON.stringify(message));
  }

  function closeInvalid(socket: WebSocket, reason: string): void {
    log({ level: "warn", event: "link-rejected", reason });
    socket.close(LINK_CLOSE.invalidMessage);
  }

  function deliver(socket: WebSocket, connection: Connection, callId: string, result: ToolResult): void {
    if (!connection.issued.has(callId)) {
      closeInvalid(socket, "result-for-unissued-call");
      return;
    }
    // A VM is untrusted, so its output gets the same cap again here.
    const capped = capText(result.output);
    const safe: ToolResult = { ...result, output: capped.output, truncated: result.truncated || capped.truncated };
    const waiters = connection.waiters.get(callId);
    connection.waiters.delete(callId);
    for (const waiter of waiters ?? []) {
      waiter(safe);
    }
  }

  const server = new WebSocketServer({
    host: args.host,
    port: args.port,
    maxPayload: MAX_COMPUTER_MESSAGE_BYTES,
  });

  server.on("listening", () => {
    log({ level: "info", event: "link-listening", host: args.host, port: args.port });
  });

  const liveness = new WeakMap<WebSocket, boolean>();
  setInterval(() => {
    for (const socket of server.clients) {
      if (liveness.get(socket) === false) {
        socket.terminate();
        continue;
      }
      liveness.set(socket, false);
      socket.ping();
    }
  }, PING_INTERVAL_MS).unref();

  server.on("connection", (socket) => {
    let state: SocketState = { kind: "awaitingHello" };
    const helloTimer = setTimeout(() => closeInvalid(socket, "hello-timeout"), HELLO_TIMEOUT_MS);
    liveness.set(socket, true);
    socket.on("pong", () => liveness.set(socket, true));

    async function authenticate(token: string, accepts: ReadonlySet<string>): Promise<void> {
      const computer = await args.authenticate(token);
      if (socket.readyState !== WebSocket.OPEN) {
        return;
      }
      if (computer === null) {
        log({ level: "warn", event: "link-rejected", reason: "unknown-token" });
        socket.close(LINK_CLOSE.unauthorized);
        return;
      }
      state = { kind: "ready", connection: addConnection(socket, computer, accepts) };
      send(socket, { kind: "welcome" });
      log({ level: "info", event: "computer-connected", computerId: computer.computerId });
    }

    // Only a stream this link asked for can attach, and only with the token of a computer that the stream's owner holds.
    async function attachStream(token: string, streamId: string): Promise<void> {
      const pending = pendingStreams.get(streamId);
      if (pending === undefined) {
        closeInvalid(socket, "unknown-stream");
        return;
      }
      const computer = await args.authenticate(token);
      if (socket.readyState !== WebSocket.OPEN) {
        return;
      }
      if (computer === null || computer.ownerId !== pending.ownerId || !pendingStreams.delete(streamId)) {
        log({ level: "warn", event: "link-rejected", reason: "stream-not-for-this-computer" });
        socket.close(LINK_CLOSE.unauthorized);
        return;
      }
      state = { kind: "stream" };
      pending.attach(socket);
      send(socket, { kind: "welcome" });
    }

    socket.on("message", (raw: Buffer) => {
      // Once attached, the relay owns every byte on this socket.
      if (state.kind === "stream") {
        return;
      }
      const message = parseJsonMessage({ raw: raw.toString("utf8"), schema: computerMessage });
      if (message === null) {
        closeInvalid(socket, "invalid-message");
        return;
      }
      switch (message.kind) {
        case "hello":
          if (state.kind !== "awaitingHello") {
            closeInvalid(socket, "unexpected-hello");
            return;
          }
          clearTimeout(helloTimer);
          state = { kind: "authenticating" };
          authenticate(message.token, new Set(message.tools ?? TOOLS_BEFORE_ANNOUNCEMENT)).catch((error: unknown) => {
            log({
              level: "error",
              event: "link-auth-failed",
              message: error instanceof Error ? error.message : "unknown error",
            });
            socket.close(LINK_CLOSE.internalError);
          });
          return;
        case "streamHello":
          if (state.kind !== "awaitingHello") {
            closeInvalid(socket, "unexpected-hello");
            return;
          }
          clearTimeout(helloTimer);
          state = { kind: "authenticating" };
          attachStream(message.token, message.streamId).catch((error: unknown) => {
            log({
              level: "error",
              event: "link-auth-failed",
              message: error instanceof Error ? error.message : "unknown error",
            });
            socket.close(LINK_CLOSE.internalError);
          });
          return;
        case "toolResult":
          if (state.kind !== "ready") {
            closeInvalid(socket, "result-before-hello");
            return;
          }
          deliver(socket, state.connection, message.callId, message.result);
          return;
      }
    });

    socket.on("close", (code) => {
      clearTimeout(helloTimer);
      if (state.kind === "ready") {
        log({ level: "info", event: "computer-disconnected", computerId: state.connection.computer.computerId });
        dropConnection(state.connection, code);
      }
    });
    socket.on("error", (error) => {
      log({ level: "warn", event: "link-socket-error", message: error.message });
    });
  });

  type CallArgs = Parameters<Link["call"]>[0];

  function computerdRefusedBrowsing(call: CallArgs, closeCode: number | undefined): boolean {
    return call.browsing !== undefined && closeCode === LINK_CLOSE.invalidMessage;
  }

  // Everything below settles exactly once through `settle`, whichever of the waits below finishes first.
  function raceStep(call: CallArgs, arm: (settle: (step: Step) => void, cleanup: AbortSignal) => void): Promise<Step> {
    const cleanup = new AbortController();
    const { promise, resolve } = Promise.withResolvers<Step>();
    const settle = (step: Step) => {
      cleanup.abort();
      resolve(step);
    };
    call.lost.addEventListener("abort", () => settle({ kind: "lost" }), { signal: cleanup.signal });
    if (call.lost.aborted) {
      settle({ kind: "lost" });
    } else {
      arm(settle, cleanup.signal);
    }
    return promise;
  }

  function timer(ms: number, onFire: () => void, cleanup: AbortSignal): void {
    const handle = setTimeout(onFire, ms);
    cleanup.addEventListener("abort", () => clearTimeout(handle));
  }

  function afterCancel(call: CallArgs, onCancel: () => void, cleanup: AbortSignal): void {
    if (call.cancel.aborted) {
      onCancel();
    } else {
      call.cancel.addEventListener("abort", onCancel, { signal: cleanup });
    }
  }

  function awaitComputer(call: CallArgs): Promise<Step> {
    return raceStep(call, (settle, cleanup) => {
      const notify = () => {
        if (connections.has(call.ownerId)) {
          settle({ kind: "retry" });
        }
      };
      onConnect.add(notify);
      cleanup.addEventListener("abort", () => onConnect.delete(notify));
      timer(args.computerWaitMs, () => settle({ kind: "gaveUp" }), cleanup);
      afterCancel(call, () => timer(CANCEL_GRACE_MS, () => settle({ kind: "gaveUp" }), cleanup), cleanup);
    });
  }

  function exchange(call: CallArgs, connection: Connection): Promise<Step> {
    return raceStep(call, (settle, cleanup) => {
      const { socket } = connection;
      const onResult = (result: ToolResult) => settle({ kind: "result", result });
      const onDrop = (closeCode: number | undefined) => settle(computerdRefusedBrowsing(call, closeCode) ? { kind: "gaveUp" } : { kind: "retry" });
      const waiters = connection.waiters.get(call.callId) ?? new Set();
      connection.waiters.set(call.callId, waiters);
      waiters.add(onResult);
      connection.onDrop.add(onDrop);
      cleanup.addEventListener("abort", () => {
        waiters.delete(onResult);
        connection.onDrop.delete(onDrop);
      });
      if (connection.issued.size >= MAX_ISSUED_PER_SOCKET) {
        const oldest = connection.issued.values().next().value;
        if (oldest !== undefined) {
          connection.issued.delete(oldest);
        }
      }
      connection.issued.add(call.callId);
      timer(responseDeadlineMs(call.tool), () => settle({ kind: "gaveUp" }), cleanup);
      if (!call.cancel.aborted) {
        send(socket, { kind: "toolCall", callId: call.callId, botId: call.botId, tool: call.tool, ...(call.browsing === undefined ? {} : { browsing: call.browsing }) });
      }
      afterCancel(
        call,
        () => {
          send(socket, { kind: "cancelTool", callId: call.callId });
          timer(CANCEL_GRACE_MS, () => settle({ kind: "gaveUp" }), cleanup);
        },
        cleanup,
      );
    });
  }

  return {
    isConnected: (ownerId) => connections.has(ownerId),
    openStream: ({ ownerId, botId, mode }) => {
      const connection = connections.get(ownerId);
      if (connection === undefined) {
        return Promise.resolve("no-computer");
      }
      const open = openStreams.get(ownerId) ?? 0;
      if (open >= MAX_STREAMS_PER_OWNER) {
        return Promise.resolve("too-many");
      }
      openStreams.set(ownerId, open + 1);
      const release = () => {
        const count = (openStreams.get(ownerId) ?? 1) - 1;
        if (count <= 0) {
          openStreams.delete(ownerId);
        } else {
          openStreams.set(ownerId, count);
        }
      };
      return new Promise((resolve) => {
        const streamId = randomUUID();
        const timeout = setTimeout(() => {
          pendingStreams.delete(streamId);
          release();
          resolve("no-computer");
        }, STREAM_ATTACH_TIMEOUT_MS);
        pendingStreams.set(streamId, {
          ownerId,
          attach: (socket) => {
            clearTimeout(timeout);
            socket.once("close", release);
            resolve(socket);
          },
        });
        send(connection.socket, { kind: "screenOpen", streamId, botId, ...(mode === "control" ? { mode } : {}) });
      });
    },
    // Authentication happens only at hello, so a revoked token keeps working on a live socket until this closes it.
    disconnect: (ownerId) => {
      const connection = connections.get(ownerId);
      if (connection === undefined) {
        return;
      }
      dropConnection(connection);
      connection.socket.close(LINK_CLOSE.unauthorized);
    },
    sendBrowsingEnd: ({ ownerId, botId, browsing }) => {
      const connection = connections.get(ownerId);
      if (connection !== undefined) {
        send(connection.socket, { kind: "browsingEnd", botId, key: browsing.key });
      }
    },
    async call(call) {
      for (;;) {
        const connection = connections.get(call.ownerId);
        if (connection !== undefined && !connection.accepts.has(call.tool.name)) {
          return { outcome: "error", output: OLDER_COMPUTERD_OUTPUT, truncated: false };
        }
        const step = await (connection === undefined ? awaitComputer(call) : exchange(call, connection));
        switch (step.kind) {
          case "result":
            return step.result;
          case "retry":
            continue;
          case "lost":
            throw call.lost.reason;
          case "gaveUp":
            return call.cancel.aborted
              ? { outcome: "cancelled", output: CANCELLED_UNREACHABLE_OUTPUT, truncated: false }
              : { outcome: "unavailable", output: UNAVAILABLE_OUTPUT, truncated: false };
        }
      }
    },
  };
}
