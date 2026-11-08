import {
  COMPUTER_TOOL_NAMES,
  LINK_CLOSE,
  MAX_ORCHESTRATOR_MESSAGE_BYTES,
  orchestratorMessage,
  parseJsonMessage,
  type ComputerMessage,
  type StreamMode,
  type ToolResult,
} from "@bots/protocol";
import { WebSocket } from "ws";
import type { Calls } from "./calls.ts";
import { log } from "./log.ts";

const FIRST_RETRY_MS = 250;
const MAX_RETRY_MS = 5000;
// A replaced connection means another computerd holds this token, so an instant retry would start a fight between them.
const RETRY_AFTER_REPLACED_MS = 30_000;
const SILENCE_LIMIT_MS = 30_000;

function failureResult(callId: string, error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : "unknown error";
  log({ level: "error", event: "call-failed", callId, message });
  return { outcome: "error", output: `computerd could not complete the call: ${message}`, truncated: false };
}

export function connectLink(args: {
  url: string;
  token: string;
  calls: Calls;
  openScreen: (streamId: string, botId: string, mode: StreamMode) => void;
  endBrowsing: (botId: string, key: string) => void;
}): void {
  const { url, token, calls, openScreen, endBrowsing } = args;
  let retryMs = FIRST_RETRY_MS;

  function connect(): void {
    const socket = new WebSocket(url, { maxPayload: MAX_ORCHESTRATOR_MESSAGE_BYTES, handshakeTimeout: 10_000 });
    let silence: NodeJS.Timeout | undefined;

    function resetSilence(): void {
      clearTimeout(silence);
      silence = setTimeout(() => socket.terminate(), SILENCE_LIMIT_MS);
    }

    function send(message: ComputerMessage): void {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
      }
    }

    // The answer goes back on the socket that asked. A lost answer is replayed when the runner asks again.
    function answer(callId: string, result: Promise<ToolResult>): void {
      result
        .catch((error: unknown) => failureResult(callId, error))
        .then((settled) => {
          log({ level: "info", event: "tool-answered", callId, outcome: settled.outcome, truncated: settled.truncated });
          send({ kind: "toolResult", callId, result: settled });
        });
    }

    socket.on("open", () => {
      resetSilence();
      send({ kind: "hello", token, tools: [...COMPUTER_TOOL_NAMES] });
    });
    socket.on("ping", resetSilence);
    socket.on("message", (raw: Buffer) => {
      resetSilence();
      const message = parseJsonMessage({ raw: raw.toString("utf8"), schema: orchestratorMessage });
      if (message === null) {
        log({ level: "warn", event: "invalid-message" });
        socket.close(LINK_CLOSE.invalidMessage);
        return;
      }
      switch (message.kind) {
        case "welcome":
          retryMs = FIRST_RETRY_MS;
          log({ level: "info", event: "link-ready" });
          return;
        case "toolCall":
          log({ level: "info", event: "tool-call", callId: message.callId, tool: message.tool.name, browsing: message.browsing?.key });
          answer(message.callId, calls.call(message));
          return;
        case "screenOpen":
          log({ level: "info", event: "screen-open", botId: message.botId, mode: message.mode ?? "watch" });
          openScreen(message.streamId, message.botId, message.mode ?? "watch");
          return;
        case "browsingEnd":
          log({ level: "info", event: "browsing-end", botId: message.botId, browsing: message.key });
          endBrowsing(message.botId, message.key);
          return;
        case "cancelTool":
          log({ level: "info", event: "tool-cancel", callId: message.callId });
          answer(message.callId, calls.cancel(message.callId));
          return;
      }
    });
    socket.on("error", (error) => {
      log({ level: "warn", event: "link-error", message: error.message });
    });
    socket.on("close", (code) => {
      clearTimeout(silence);
      const delay = code === LINK_CLOSE.replaced ? RETRY_AFTER_REPLACED_MS : retryMs;
      retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
      log({ level: "info", event: "link-closed", code, retryInMs: delay });
      setTimeout(connect, delay);
    });
  }

  connect();
}
