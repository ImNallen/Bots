import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Id } from "@bots/convex/dataModel";
import { LINK_CLOSE } from "@bots/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { attachScreens, isSameOrigin } from "./screens.ts";

const OWNER = "owner" as Id<"users">;

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
  let opened: Array<{ ownerId: Id<"users">; botId: string }>;

  beforeEach(async () => {
    computerSide = [];
    opened = [];
    stream = "computer";
    server = createServer();
    const fakeComputer = new WebSocketServer({ noServer: true });
    attachScreens({
      server,
      authMode: { kind: "tailscale" },
      ownerForViewer: async (botId, subject) => (botId === "my-bot" && subject === "tailscale:me@example" ? { ownerId: OWNER } : null),
      log: () => {},
      link: {
        openStream: async (args) => {
          opened.push(args);
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
    await until(() => computerSide.length === 1);
    expect(opened).toEqual([{ ownerId: OWNER, botId: "my-bot" }]);
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

  it("tells the viewer when there are too many streams", async () => {
    stream = "too-many";
    expect(await closeCode(viewer())).toBe(LINK_CLOSE.tooManyStreams);
  });
});
