import { connect, type Socket } from "node:net";
import { orchestratorMessage, parseJsonMessage } from "@bots/protocol";
import { WebSocket } from "ws";
import { log } from "./log.ts";

const FIRST_SCREEN_PORT = 5900;
const MAX_INBOUND_BYTES = 64 * 1024;
const PAUSE_ABOVE_BYTES = 1024 * 1024;

// A VM takes no inbound connections, so a stream is one more connection that this computer dials to the link.
export function relayScreen(args: {
  linkUrl: string;
  token: string;
  streamId: string;
  regionFor: () => Promise<number>;
}): void {
  const { linkUrl, token, streamId, regionFor } = args;
  const socket = new WebSocket(linkUrl, { maxPayload: MAX_INBOUND_BYTES, handshakeTimeout: 10_000 });
  let screen: Socket | null = null;

  function startRelay(region: number): void {
    const tcp = connect(FIRST_SCREEN_PORT + region, "127.0.0.1");
    screen = tcp;
    tcp.on("data", (chunk) => {
      if (socket.readyState !== WebSocket.OPEN) {
        return;
      }
      socket.send(chunk, { binary: true }, () => {
        if (socket.bufferedAmount < PAUSE_ABOVE_BYTES) {
          tcp.resume();
        }
      });
      if (socket.bufferedAmount >= PAUSE_ABOVE_BYTES) {
        tcp.pause();
      }
    });
    tcp.on("close", () => socket.close());
    tcp.on("error", (error) => {
      log({ level: "warn", event: "screen-relay-failed", message: error.message });
      socket.close();
    });
  }

  socket.on("open", () => socket.send(JSON.stringify({ kind: "streamHello", token, streamId })));
  socket.on("message", (raw: Buffer, isBinary: boolean) => {
    if (isBinary) {
      screen?.write(raw);
      return;
    }
    if (screen !== null || parseJsonMessage({ raw: raw.toString("utf8"), schema: orchestratorMessage })?.kind !== "welcome") {
      return;
    }
    regionFor().then(startRelay, (error: unknown) => {
      log({ level: "warn", event: "screen-relay-failed", message: error instanceof Error ? error.message : "unknown error" });
      socket.close();
    });
  });
  socket.on("close", () => screen?.destroy());
  socket.on("error", (error) => log({ level: "warn", event: "screen-relay-failed", message: error.message }));
}
