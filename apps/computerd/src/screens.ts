import { connect, type Socket } from "node:net";
import { orchestratorMessage, parseJsonMessage, type StreamMode } from "@bots/protocol";
import { WebSocket } from "ws";
import { streamPort, type DesktopLease, type Slot } from "./desktops.ts";
import { log } from "./log.ts";

const MAX_INBOUND_BYTES = 64 * 1024;
const PAUSE_ABOVE_BYTES = 1024 * 1024;

// A VM takes no inbound connections, so a stream is one more connection that this computer dials to the link.
// The relay holds a lease for as long as it runs, so a viewer's desktop is never stopped.
export function relayScreen(args: {
  linkUrl: string;
  token: string;
  streamId: string;
  mode: StreamMode;
  acquire: () => Promise<DesktopLease>;
  restartInput: (slot: Slot) => Promise<void>;
}): void {
  const { linkUrl, token, streamId, mode, acquire, restartInput } = args;
  const socket = new WebSocket(linkUrl, { maxPayload: MAX_INBOUND_BYTES, handshakeTimeout: 10_000 });
  let screen: Socket | null = null;
  let lease: DesktopLease | null = null;
  let welcomed = false;

  async function open(): Promise<void> {
    const granted = await acquire();
    try {
      // The owner can leave during a slow start, and no close event will come to release this lease. A restart now would also
      // end the take-over of a newer tab for nothing.
      if (socket.readyState === WebSocket.OPEN && mode === "control") {
        await restartInput(granted.slot);
      }
    } catch (error) {
      granted.release();
      throw error;
    }
    if (socket.readyState !== WebSocket.OPEN) {
      granted.release();
      return;
    }
    lease = granted;
    const tcp = connect(streamPort(granted.slot, mode), "127.0.0.1");
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
    if (welcomed || parseJsonMessage({ raw: raw.toString("utf8"), schema: orchestratorMessage })?.kind !== "welcome") {
      return;
    }
    welcomed = true;
    open().catch((error: unknown) => {
      log({ level: "warn", event: "screen-relay-failed", message: error instanceof Error ? error.message : "unknown error" });
      socket.close();
    });
  });
  socket.on("close", () => {
    screen?.destroy();
    lease?.release();
  });
  socket.on("error", (error) => log({ level: "warn", event: "screen-relay-failed", message: error.message }));
}
