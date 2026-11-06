import { createServer, type Server, type Socket } from "node:net";
import type { StreamMode } from "@bots/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { desktopOf, streamPort, type DesktopLease, type Slot } from "./desktops.ts";
import { relayScreen } from "./screens.ts";

const SLOT: Slot = 8;
const CDP_PORT = desktopOf(SLOT).cdpPort;
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
    opened?: () => Promise<void>;
    closed?: () => Promise<void>;
  }) {
    // Each relay has its own count and list, so a release from the test before cannot land in this one.
    const seen = events;
    const leases = {
      released: 0,
      lease: {
        ...desktopOf(SLOT),
        release: () => {
          leases.released += 1;
          seen.push("release");
        },
      },
    };
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
          seen.push(`restart ${slot}`);
        }),
      logins: {
        opened: async (cdpPort) => {
          seen.push(`opened ${cdpPort}`);
          await args.opened?.();
        },
        closed: async (cdpPort) => {
          seen.push(`closed ${cdpPort}`);
          await args.closed?.();
        },
      },
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
    expect(events).toEqual([`opened ${CDP_PORT}`, `restart ${SLOT}`, "dial control"]);
  });

  it("keeps the lease until the logins have moved, however long that takes", async () => {
    let moved: () => void = () => {};
    const leases = relay({ mode: "control", closed: () => new Promise((resolve) => (moved = resolve)) });
    await until(() => dialed.length === 1);
    (orchestratorSide[0] as WebSocket).close();
    await until(() => events.includes(`closed ${CDP_PORT}`));
    await new Promise((done) => setTimeout(done, 20));
    expect(leases.released).toBe(0);
    moved();
    await until(() => leases.released === 1);
    expect(events.slice(-2)).toEqual([`closed ${CDP_PORT}`, "release"]);
  });

  it("moves the logins when the stream ends by itself, as a phone that drops makes it do", async () => {
    const leases = relay({ mode: "control" });
    await until(() => dialed.length === 1);
    (dialed[0] as { socket: Socket }).socket.destroy();
    await until(() => leases.released === 1);
    expect(events.filter((event) => event.startsWith("closed"))).toEqual([`closed ${CDP_PORT}`]);
  });

  it("moves no logins for a watch stream", async () => {
    const leases = relay({ mode: "watch" });
    await until(() => dialed.length === 1);
    (orchestratorSide[0] as WebSocket).close();
    await until(() => leases.released === 1);
    expect(events).toEqual(["dial watch", "release"]);
  });

  it("closes the count it opened when the input stream cannot start", async () => {
    const leases = relay({ mode: "control", restartInput: () => Promise.reject(new Error("no sudo")) });
    await until(() => leases.released === 1);
    expect(events).toEqual([`opened ${CDP_PORT}`, `closed ${CDP_PORT}`, "release"]);
  });

  it("does not end a newer tab's take-over for an owner who left while the baseline was written", async () => {
    let written: () => void = () => {};
    const leases = relay({ mode: "control", opened: () => new Promise((resolve) => (written = resolve)) });
    await until(() => events.includes(`opened ${CDP_PORT}`));
    (orchestratorSide[0] as WebSocket).close();
    await until(() => closes.count === 1);
    written();
    await until(() => leases.released === 1);
    expect(events).toEqual([`opened ${CDP_PORT}`, `closed ${CDP_PORT}`, "release"]);
  });

  it("closes the count it opened when the owner leaves during the restart", async () => {
    let restarted: () => void = () => {};
    const leases = relay({ mode: "control", restartInput: () => new Promise((resolve) => (restarted = resolve)) });
    await until(() => events.includes(`opened ${CDP_PORT}`));
    await new Promise((done) => setTimeout(done, 20));
    (orchestratorSide[0] as WebSocket).close();
    await until(() => closes.count === 1);
    restarted();
    await until(() => leases.released === 1);
    expect(events).toEqual([`opened ${CDP_PORT}`, `closed ${CDP_PORT}`, "release"]);
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
    expect(events).toEqual(["release"]);
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
