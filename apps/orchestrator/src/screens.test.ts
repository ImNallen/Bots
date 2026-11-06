import { createServer, type Server } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import type { Id } from "@bots/convex/dataModel";
import { LINK_CLOSE, type StreamMode } from "@bots/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { attachScreens, isSameOrigin } from "./screens.ts";

const OWNER = "owner" as Id<"users">;
const TAKEOVER_CHECK_MS = 20;

describe("isSameOrigin", () => {
  it.each([
    [{ origin: "https://bots.example.ts.net", host: "bots.example.ts.net" }, true],
    [{ origin: "http://127.0.0.1:5173", host: "127.0.0.1:5173" }, true],
    [{ origin: "https://evil.example", host: "bots.example.ts.net" }, false],
    [{ origin: "https://bots.example.ts.net.evil.example", host: "bots.example.ts.net" }, false],
    [{ host: "bots.example.ts.net" }, false],
    [{ origin: "null", host: "bots.example.ts.net" }, false],
    [{ origin: "https://bots.example.ts.net" }, false],
  ])("%j gives %s", (headers, expected) => {
    expect(isSameOrigin(headers)).toBe(expected);
  });
});

describe("attachScreens", () => {
  let server: Server;
  let port: number;
  let computerSide: WebSocket[];
  let stream: "computer" | "no-computer" | "too-many";
  let openDelayMs: number;
  let ownerDelayMs: number;
  let logged: string[];
  let takeoverUntil: number;
  let loggedFields: unknown[];
  let opened: Array<{ ownerId: Id<"users">; botId: string; mode: StreamMode }>;

  beforeEach(async () => {
    computerSide = [];
    opened = [];
    stream = "computer";
    openDelayMs = 0;
    ownerDelayMs = 0;
    logged = [];
    takeoverUntil = 0;
    loggedFields = [];
    server = createServer();
    const fakeComputer = new WebSocketServer({ noServer: true });
    attachScreens({
      server,
      authMode: { kind: "tailscale" },
      ownerForViewer: async (botId, subject) => {
        await new Promise((done) => setTimeout(done, ownerDelayMs));
        return botId === "my-bot" && subject === "tailscale:me@example" ? { ownerId: OWNER, takeoverUntil } : null;
      },
      log: (fields) => {
        logged.push(fields.event);
        loggedFields.push(fields);
      },
      takeoverCheckMs: TAKEOVER_CHECK_MS,
      link: {
        openStream: async (args) => {
          opened.push(args);
          await new Promise((done) => setTimeout(done, openDelayMs));
          if (stream !== "computer") {
            return stream;
          }
          const http = createServer();
          http.on("upgrade", (request, socket, head) => {
            fakeComputer.handleUpgrade(request, socket, head, (near) => computerSide.push(near));
          });
          await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
          const address = http.address() as AddressInfo;
          const far = new WebSocket(`ws://127.0.0.1:${address.port}`);
          await new Promise((resolve) => far.once("open", resolve));
          return far;
        },
      },
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(() => {
    server.close();
  });

  function viewer(args: { path?: string; origin?: string | null; login?: string | null } = {}) {
    const { path = "/screens/my-bot", origin = `http://127.0.0.1:${port}`, login = "me@example" } = args;
    return new WebSocket(`ws://127.0.0.1:${port}${path}`, {
      headers: { ...(origin === null ? {} : { Origin: origin }), ...(login === null ? {} : { "Tailscale-User-Login": login }) },
    });
  }
  const rejection = (socket: WebSocket) =>
    new Promise<number>((resolve) => {
      socket.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
      socket.once("error", () => {});
    });
  const closeCode = (socket: WebSocket) => new Promise<number>((resolve) => socket.once("close", resolve));
  const until = async (condition: () => boolean) => {
    while (!condition()) {
      await new Promise((done) => setTimeout(done, 5));
    }
  };

  it("refuses a page from another site, even with a real identity", async () => {
    expect(await rejection(viewer({ origin: "https://evil.example" }))).toBe(403);
    expect(opened).toEqual([]);
  });

  it("refuses a request with no origin", async () => {
    expect(await rejection(viewer({ origin: null }))).toBe(403);
    expect(opened).toEqual([]);
  });

  it("refuses a request with no identity", async () => {
    expect(await rejection(viewer({ login: null }))).toBe(403);
    expect(opened).toEqual([]);
  });

  it("refuses a user who does not own the bot", async () => {
    expect(await rejection(viewer({ login: "other@example" }))).toBe(403);
    expect(opened).toEqual([]);
  });

  it("refuses a bot that does not exist", async () => {
    expect(await rejection(viewer({ path: "/screens/not-mine" }))).toBe(403);
    expect(opened).toEqual([]);
  });

  it.each(["/screens/", "/screens/a/b", "/other", "/screens/%2e%2e"])("does not treat %s as a screen", async (path) => {
    expect(await rejection(viewer({ path }))).toBe(404);
  });

  it("relays binary data both ways between the owner and the computer", async () => {
    const socket = viewer();
    await new Promise((resolve) => socket.once("open", resolve));
    // The real computer sends nothing until the link's welcome, which comes after the relay attaches. This fake has no welcome.
    await until(() => logged.includes("screen-opened"));
    expect(opened).toEqual([{ ownerId: OWNER, botId: "my-bot", mode: "watch" }]);
    const near = computerSide[0] as WebSocket;

    const toViewer = new Promise<Buffer>((resolve) => socket.once("message", (data: Buffer) => resolve(data)));
    near.send(Buffer.from([1, 2, 3]));
    expect([...(await toViewer)]).toEqual([1, 2, 3]);

    const toComputer = new Promise<Buffer>((resolve) => near.once("message", (data: Buffer) => resolve(data)));
    socket.send(Buffer.from([4, 5]));
    expect([...(await toComputer)]).toEqual([4, 5]);
  });

  it("closes the computer's side when the viewer leaves", async () => {
    const socket = viewer();
    await new Promise((resolve) => socket.once("open", resolve));
    await until(() => computerSide.length === 1);
    const closed = closeCode(computerSide[0] as WebSocket);
    socket.close();
    await closed;
  });

  it("tells the viewer when no computer is connected", async () => {
    stream = "no-computer";
    expect(await closeCode(viewer())).toBe(LINK_CLOSE.noComputer);
  });

  describe("input", () => {
    const inputPath = "/screens/my-bot/input";
    const open = (socket: WebSocket) => new Promise((resolve) => socket.once("open", resolve));

    it("is refused when the owner has not taken over", async () => {
      expect(await rejection(viewer({ path: inputPath }))).toBe(403);
    });

    it("is refused from another site during a take-over", async () => {
      takeoverUntil = Date.now() + 60_000;
      expect(await rejection(viewer({ path: inputPath, origin: "https://evil.example" }))).toBe(403);
    });

    it("is refused for a user who does not own the bot during a take-over", async () => {
      takeoverUntil = Date.now() + 60_000;
      expect(await rejection(viewer({ path: inputPath, login: "other@example" }))).toBe(403);
    });

    async function takenOver() {
      takeoverUntil = Date.now() + 60_000;
      const socket = viewer({ path: inputPath });
      await open(socket);
      await until(() => logged.includes("screen-opened"));
      return { socket, near: computerSide[0] as WebSocket };
    }

    it("opens a control stream during a take-over, and relays bytes both ways", async () => {
      const { socket, near } = await takenOver();
      expect(opened).toEqual([{ ownerId: OWNER, botId: "my-bot", mode: "control" }]);

      const toViewer = new Promise<Buffer>((resolve) => socket.once("message", (data: Buffer) => resolve(data)));
      near.send(Buffer.from([1, 2, 3]));
      expect([...(await toViewer)]).toEqual([1, 2, 3]);

      const toComputer = new Promise<Buffer>((resolve) => near.once("message", (data: Buffer) => resolve(data)));
      socket.send(Buffer.from([4, 5]));
      expect([...(await toComputer)]).toEqual([4, 5]);
      socket.close();
    });

    it("logs nothing of what a person types", async () => {
      const { socket, near } = await takenOver();
      const toComputer = new Promise<Buffer>((resolve) => near.once("message", (data: Buffer) => resolve(data)));
      socket.send(Buffer.from("hunter2-secret"));
      expect((await toComputer).toString()).toBe("hunter2-secret");
      expect(JSON.stringify(loggedFields)).not.toContain("hunter2");
      socket.close();
    });

    it("stays open while the take-over holds", async () => {
      const { socket } = await takenOver();
      await new Promise((done) => setTimeout(done, TAKEOVER_CHECK_MS * 4));
      expect(socket.readyState).toBe(WebSocket.OPEN);
      socket.close();
    });

    it("closes both ends when the take-over ends", async () => {
      const { socket, near } = await takenOver();
      const viewerClosed = closeCode(socket);
      const computerClosed = closeCode(near);
      takeoverUntil = 0;
      expect(await viewerClosed).toBe(LINK_CLOSE.takeoverEnded);
      await computerClosed;
    });

    it("cuts the computer off at once from a viewer that never answers the close", async () => {
      takeoverUntil = Date.now() + 60_000;
      const client = await new Promise<Socket>((resolve) => {
        const raw = connect(port, "127.0.0.1", () => resolve(raw));
        raw.on("error", () => {});
      });
      client.write(
        `GET ${inputPath} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: http://127.0.0.1:${port}\r\nTailscale-User-Login: me@example\r\n` +
          "Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
      );
      await until(() => computerSide.length === 1);
      const computerClosed = closeCode(computerSide[0] as WebSocket);
      takeoverUntil = 0;
      await computerClosed;
      client.destroy();
    });

    it("tells the owner when no computer is connected", async () => {
      takeoverUntil = Date.now() + 60_000;
      stream = "no-computer";
      expect(await closeCode(viewer({ path: inputPath }))).toBe(LINK_CLOSE.noComputer);
    });
  });

  describe("a viewer that misbehaves ends only itself", () => {
    const INVALID_FRAME = Buffer.from([0xff, 0xff, 0xff, 0xff]);
    const handshake = (client: Socket) =>
      client.write(
        `GET /screens/my-bot HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: http://127.0.0.1:${port}\r\nTailscale-User-Login: me@example\r\n` +
          "Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
      );
    const rawClient = () =>
      new Promise<Socket>((resolve) => {
        const client = connect(port, "127.0.0.1", () => resolve(client));
        client.on("error", () => {});
      });
    const stillServes = async () => {
      stream = "no-computer";
      expect(await closeCode(viewer())).toBe(LINK_CLOSE.noComputer);
    };

    it.each(["no-computer", "too-many", "computer"] as const)("when a bad frame arrives while the stream is %s", async (result) => {
      stream = result;
      openDelayMs = 30;
      const client = await rawClient();
      const upgraded = new Promise<void>((resolve) => client.once("data", () => resolve()));
      handshake(client);
      await upgraded;
      client.write(INVALID_FRAME);
      await until(() => logged.includes("screen-viewer-error"));
      openDelayMs = 0;
      await stillServes();
      client.destroy();
    });

    it("when a frame is larger than the limit", async () => {
      stream = "no-computer";
      openDelayMs = 30;
      const client = await rawClient();
      const upgraded = new Promise<void>((resolve) => client.once("data", () => resolve()));
      handshake(client);
      await upgraded;
      // A masked binary frame that claims 1 MiB, past the 64 KiB limit.
      const header = Buffer.from([0x82, 0xff, 0, 0, 0, 0, 0, 0x10, 0, 0, 1, 2, 3, 4]);
      client.write(header);
      await until(() => logged.includes("screen-viewer-error"));
      client.destroy();
      openDelayMs = 0;
      await stillServes();
    });

    it("when the client resets the connection during the identity check", async () => {
      ownerDelayMs = 50;
      const client = await rawClient();
      handshake(client);
      await new Promise((done) => setTimeout(done, 10));
      client.resetAndDestroy();
      await new Promise((done) => setTimeout(done, 80));
      ownerDelayMs = 0;
      await stillServes();
    });
  });

  it("tells the viewer when there are too many streams", async () => {
    stream = "too-many";
    expect(await closeCode(viewer())).toBe(LINK_CLOSE.tooManyStreams);
  });
});
