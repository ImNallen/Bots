import { createServer } from "node:net";
import type { Id } from "@bots/convex/dataModel";
import { LINK_CLOSE, type OrchestratorMessage, type ToolInvocation } from "@bots/protocol";
import { beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { startLink, type Link } from "./link.ts";

const OWNER = "owner" as Id<"users">;
const tool: ToolInvocation = { name: "read_file", args: { path: "a" } };

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address !== null ? address.port : 0));
    });
  });
}

let port: number;
let link: Link;

beforeAll(async () => {
  port = await freePort();
  link = startLink({
    host: "127.0.0.1",
    port,
    computerWaitMs: 300,
    authenticate: async (token) =>
      token === "good" ? { computerId: "computer" as Id<"computers">, ownerId: OWNER } : null,
    log: () => {},
  });
});

type Computer = { socket: WebSocket; received: OrchestratorMessage[]; closed: Promise<number> };

async function connectComputer(): Promise<Computer> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const received: OrchestratorMessage[] = [];
  const welcomed = Promise.withResolvers<void>();
  socket.on("message", (raw: Buffer) => {
    const message = JSON.parse(raw.toString("utf8")) as OrchestratorMessage;
    received.push(message);
    if (message.kind === "welcome") {
      welcomed.resolve();
    }
  });
  const closed = new Promise<number>((resolve) => socket.once("close", resolve));
  await new Promise((resolve) => socket.once("open", resolve));
  socket.send(JSON.stringify({ kind: "hello", token: "good" }));
  await welcomed.promise;
  return { socket, received, closed };
}

function callArgs(callId: string, signals?: { cancel?: AbortSignal; lost?: AbortSignal }) {
  return {
    ownerId: OWNER,
    callId,
    botId: "bot",
    tool,
    lost: signals?.lost ?? new AbortController().signal,
    cancel: signals?.cancel ?? new AbortController().signal,
  };
}

async function until(condition: () => boolean): Promise<void> {
  while (!condition()) {
    await new Promise((done) => setTimeout(done, 5));
  }
}

function answer(computer: Computer, callId: string, output: string): void {
  computer.socket.send(
    JSON.stringify({ kind: "toolResult", callId, result: { outcome: "ok", output, truncated: false } }),
  );
}

describe("link", () => {
  it("records unavailable when no computer connects in time", async () => {
    const result = await link.call(callArgs("a:none"));
    expect(result.outcome).toBe("unavailable");
  });

  it("delivers a result and caps its output again, because a VM is untrusted", async () => {
    const computer = await connectComputer();
    const pending = link.call(callArgs("a:cap"));
    await until(() => computer.received.some((message) => message.kind === "toolCall"));
    answer(computer, "a:cap", "x".repeat(100_000));
    const result = await pending;
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(32 * 1024);
    computer.socket.close();
    await computer.closed;
  });

  it("sends the same call again on a new connection when the link drops mid-call", async () => {
    const first = await connectComputer();
    const pending = link.call(callArgs("a:drop"));
    await until(() => first.received.some((message) => message.kind === "toolCall"));
    first.socket.terminate();
    await first.closed;
    const second = await connectComputer();
    await until(() => second.received.some((message) => message.kind === "toolCall"));
    answer(second, "a:drop", "after reconnect");
    expect((await pending).output).toBe("after reconnect");
    second.socket.close();
    await second.closed;
  });

  it("sends the same call again on the newer connection when one replaces another", async () => {
    const older = await connectComputer();
    const pending = link.call(callArgs("a:replace"));
    await until(() => older.received.some((message) => message.kind === "toolCall"));
    const newer = await connectComputer();
    expect(await older.closed).toBe(4000);
    await until(() => newer.received.some((message) => message.kind === "toolCall"));
    answer(newer, "a:replace", "from newer");
    expect((await pending).output).toBe("from newer");
    newer.socket.close();
    await newer.closed;
  });

  it("closes a socket that answers a call it was never given, and the real call still gets its answer", async () => {
    const older = await connectComputer();
    const pending = link.call(callArgs("a:real"));
    await until(() => older.received.some((message) => message.kind === "toolCall"));
    answer(older, "a:forged", "forged");
    expect(await older.closed).toBe(1008);
    const newer = await connectComputer();
    await until(() => newer.received.some((message) => message.kind === "toolCall"));
    answer(newer, "a:real", "real");
    expect((await pending).output).toBe("real");
    newer.socket.close();
    await newer.closed;
  });

  it("sends cancelTool for a running call and returns what the computer answers", async () => {
    const computer = await connectComputer();
    const cancel = new AbortController();
    const pending = link.call(callArgs("a:cancel", { cancel: cancel.signal }));
    await until(() => computer.received.some((message) => message.kind === "toolCall"));
    cancel.abort();
    await until(() => computer.received.some((message) => message.kind === "cancelTool"));
    computer.socket.send(
      JSON.stringify({
        kind: "toolResult",
        callId: "a:cancel",
        result: { outcome: "cancelled", output: "killed", truncated: false },
      }),
    );
    expect(await pending).toMatchObject({ outcome: "cancelled", output: "killed" });
    computer.socket.close();
    await computer.closed;
  });

  it("sends only cancelTool when the run was already cancelled", async () => {
    const computer = await connectComputer();
    const cancel = new AbortController();
    cancel.abort();
    const pending = link.call(callArgs("a:precancel", { cancel: cancel.signal }));
    await until(() => computer.received.some((message) => message.kind === "cancelTool"));
    expect(computer.received.some((message) => message.kind === "toolCall")).toBe(false);
    computer.socket.send(
      JSON.stringify({
        kind: "toolResult",
        callId: "a:precancel",
        result: { outcome: "cancelled", output: "", truncated: false },
      }),
    );
    expect((await pending).outcome).toBe("cancelled");
    computer.socket.close();
    await computer.closed;
  });

  it("rejects immediately when the lease is lost, leaving the computer alone", async () => {
    const computer = await connectComputer();
    const lost = new AbortController();
    const pending = link.call(callArgs("a:lost", { lost: lost.signal }));
    await until(() => computer.received.some((message) => message.kind === "toolCall"));
    lost.abort(new Error("lease lost"));
    await expect(pending).rejects.toThrow("lease lost");
    expect(computer.received.some((message) => message.kind === "cancelTool")).toBe(false);
    computer.socket.close();
    await computer.closed;
  });

  it("ignores a late duplicate answer for a call this socket was given", async () => {
    const computer = await connectComputer();
    const pending = link.call(callArgs("a:dup"));
    await until(() => computer.received.some((message) => message.kind === "toolCall"));
    answer(computer, "a:dup", "first");
    expect((await pending).output).toBe("first");
    answer(computer, "a:dup", "second");
    await new Promise((done) => setTimeout(done, 50));
    expect(computer.socket.readyState).toBe(WebSocket.OPEN);
    computer.socket.close();
    await computer.closed;
  });
});

describe("disconnect", () => {
  it("closes a live computer as unauthorized, and new calls no longer reach it", async () => {
    const computer = await connectComputer();
    expect(link.isConnected(OWNER)).toBe(true);
    link.disconnect(OWNER);
    expect(link.isConnected(OWNER)).toBe(false);
    expect(await computer.closed).toBe(LINK_CLOSE.unauthorized);
    const before = computer.received.length;
    const result = await link.call(callArgs("run:after-disconnect"));
    expect(result.outcome).toBe("unavailable");
    expect(computer.received).toHaveLength(before);
  });

  it("does nothing for an owner with no connection", () => {
    expect(() => link.disconnect("nobody" as Id<"users">)).not.toThrow();
  });
});
