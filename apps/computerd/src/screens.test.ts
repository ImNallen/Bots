import { createServer, type Server, type Socket } from "node:net";
import type { StreamMode } from "@bots/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { desktopOf, streamPort, type DesktopLease, type Slot } from "./desktops.ts";
import { relayScreen } from "./screens.ts";

const SLOT: Slot = 8;
const until = async (condition: () => boolean) => {
  while (!condition()) {
    await new Promise((done) => setTimeout(done, 5));
  }
};

describe("relayScreen", () => {
  let link: WebSocketServer;
  let orchestratorSide: WebSocket[];
  let screens: Map<StreamMode, Server>;
  let dialed: Array<{ mode: StreamMode; socket: Socket }>;
  let closes: { count: number };
  let events: string[];

  beforeEach(async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    orchestratorSide = [];
    dialed = [];
    const thisTest = { count: 0 };
    closes = thisTest;
    events = [];
    link = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise((resolve) => link.once("listening", resolve));
    link.on("connection", (socket) => {
      socket.on("error", () => {});
      socket.on("close", () => (thisTest.count += 1));
      socket.once("message", () => {
        orchestratorSide.push(socket);
        socket.send(JSON.stringify({ kind: "welcome" }));
      });
    });
    screens = new Map();
    for (const mode of ["watch", "control"] as const) {
      const screen = createServer((socket) => {
        events.push(`dial ${mode}`);
        socket.on("error", () => {});
        socket.resume();
        dialed.push({ mode, socket });
      });
      await new Promise<void>((resolve) => screen.listen(streamPort(SLOT, mode), "127.0.0.1", resolve));
      screens.set(mode, screen);
    }
  });

  afterEach(async () => {
    for (const { socket } of dialed) {
      socket.destroy();
    }
    for (const socket of link.clients) {
      socket.terminate();
    }
    link.close();
    await Promise.all([...screens.values()].map((screen) => new Promise((resolve) => screen.close(resolve))));
    vi.restoreAllMocks();
  });

  function relay(args: {
    mode: StreamMode;
    acquire?: () => Promise<DesktopLease>;
    restartInput?: (slot: Slot) => Promise<void>;
  }) {
    // Each relay has its own count, so a release from the test before cannot land in this one.
    const leases = { released: 0, lease: { ...desktopOf(SLOT), release: () => (leases.released += 1) } };
    const { port } = link.address() as { port: number };
    relayScreen({
      linkUrl: `ws://127.0.0.1:${port}`,
      token: "token",
      streamId: "stream",
      mode: args.mode,
      acquire: args.acquire ?? (async () => leases.lease),
      restartInput:
        args.restartInput ??
        (async (slot) => {
          events.push(`restart ${slot}`);
        }),
    });
    return leases;
  }

  it("relays a watch stream from the watch port, and starts no input", async () => {
    relay({ mode: "watch" });
    await until(() => dialed.length === 1);
    expect(events).toEqual(["dial watch"]);
  });

  it("restarts the input stream before it dials, and dials the control port", async () => {
    relay({ mode: "control" });
    await until(() => dialed.length === 1);
    expect(events).toEqual([`restart ${SLOT}`, "dial control"]);
  });

  it("carries bytes both ways, and ignores a text frame", async () => {
    relay({ mode: "control" });
    await until(() => dialed.length === 1);
    const { socket: screen } = dialed[0] as { socket: Socket };
    const near = orchestratorSide[0] as WebSocket;

    const toOwner = new Promise<Buffer>((resolve) => near.once("message", (data: Buffer) => resolve(data)));
    screen.write(Buffer.from([1, 2, 3]));
    expect([...(await toOwner)]).toEqual([1, 2, 3]);

    const toScreen = new Promise<Buffer>((resolve) => screen.once("data", resolve));
    near.send(JSON.stringify({ kind: "text", text: "not for the screen" }));
    near.send(Buffer.from([4, 5]));
    expect([...(await toScreen)]).toEqual([4, 5]);
  });

  it("closes the screen's connection and frees the desktop when the owner's side closes", async () => {
    const leases = relay({ mode: "control" });
    await until(() => dialed.length === 1);
    const { socket: screen } = dialed[0] as { socket: Socket };
    const closed = new Promise((resolve) => screen.once("close", resolve));
    (orchestratorSide[0] as WebSocket).close();
    await closed;
    await until(() => leases.released === 1);
  });

  it("closes the owner's side when the stream ends by itself, as a second take-over makes it do", async () => {
    const leases = relay({ mode: "control" });
    await until(() => dialed.length === 1);
    (dialed[0] as { socket: Socket }).socket.destroy();
    await until(() => closes.count === 1 && leases.released === 1);
  });

  it("closes and frees the desktop when the input stream cannot start, and dials nothing", async () => {
    const leases = relay({ mode: "control", restartInput: () => Promise.reject(new Error("no sudo")) });
    await until(() => orchestratorSide.length === 1);
    await until(() => closes.count === 1 && leases.released === 1);
    expect(dialed).toEqual([]);
  });

  it("does not end another viewer's take-over for an owner who left during a slow start", async () => {
    let grant: (lease: DesktopLease) => void = () => {};
    const leases = relay({ mode: "control", acquire: () => new Promise((resolve) => (grant = resolve)) });
    await until(() => orchestratorSide.length === 1);
    (orchestratorSide[0] as WebSocket).close();
    await until(() => closes.count === 1);
    await new Promise((done) => setTimeout(done, 20));
    grant(leases.lease);
    await until(() => leases.released === 1);
    expect(events).toEqual([]);
  });

  it("frees the desktop and dials nothing when the owner leaves during the restart", async () => {
    let restarted: () => void = () => {};
    const leases = relay({ mode: "control", restartInput: () => new Promise((resolve) => (restarted = resolve)) });
    await until(() => orchestratorSide.length === 1);
    await new Promise((done) => setTimeout(done, 20));
    (orchestratorSide[0] as WebSocket).close();
    await until(() => closes.count === 1);
    await new Promise((done) => setTimeout(done, 20));
    restarted();
    await until(() => leases.released === 1);
    expect(dialed).toEqual([]);
  });
});
