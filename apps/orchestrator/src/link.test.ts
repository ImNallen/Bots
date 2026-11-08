import { createServer } from "node:net";
import type { Id } from "@bots/convex/dataModel";
import { LINK_CLOSE, type Browsing, type OrchestratorMessage, type ToolInvocation } from "@bots/protocol";
import { beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { OLDER_COMPUTERD_OUTPUT, startLink, type Link } from "./link.ts";

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

async function connectComputer(tools?: string[]): Promise<Computer> {
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
  socket.send(JSON.stringify({ kind: "hello", token: "good", ...(tools === undefined ? {} : { tools }) }));
  await welcomed.promise;
  return { socket, received, closed };
}

function callArgs(callId: string, signals?: { cancel?: AbortSignal; lost?: AbortSignal }) {
  return {
    ownerId: OWNER,
    callId,
    botId: "bot",
    tool,
    browsing: undefined,
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

  describe("the tools that a computerd names in its hello", () => {
    it("never sends a tool that the computerd did not name, and keeps its link open", async () => {
      const computer = await connectComputer(["shell"]);
      expect(await link.call(callArgs("a:unnamed"))).toEqual({ outcome: "error", output: OLDER_COMPUTERD_OUTPUT, truncated: false });
      const shell = link.call({ ...callArgs("a:named"), tool: { name: "shell", args: { command: "true", timeoutSeconds: 1 } } });
      await until(() => computer.received.some((message) => message.kind === "toolCall"));
      expect(computer.received.filter((message) => message.kind === "toolCall").map((message) => message.callId)).toEqual(["a:named"]);
      answer(computer, "a:named", "ran");
      expect((await shell).output).toBe("ran");
      computer.socket.close();
      expect(await computer.closed).toBe(1005);
    });

    it("never sends a desktop tool to a computerd from before the announcement", async () => {
      const computer = await connectComputer();
      expect(await link.call({ ...callArgs("a:look"), tool: { name: "desktop_look", args: {} } })).toEqual({ outcome: "error", output: OLDER_COMPUTERD_OUTPUT, truncated: false });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(computer.received.some((message) => message.kind === "toolCall")).toBe(false);
      computer.socket.close();
      await computer.closed;
    });

    it("sends a look to a computerd that names it, and passes its picture through", async () => {
      const computer = await connectComputer(["desktop_look"]);
      const pending = link.call({ ...callArgs("a:looked"), tool: { name: "desktop_look", args: {} } });
      await until(() => computer.received.some((message) => message.kind === "toolCall"));
      const screen = { width: 1280, height: 800, windows: [], active: null, marks: [], unlisted: 0, silent: [], image: { mediaType: "image/png", base64: "A".repeat(400_000) } };
      computer.socket.send(JSON.stringify({ kind: "toolResult", callId: "a:looked", result: { outcome: "ok", output: "Looked at the screen.", truncated: false, screen } }));
      expect(await pending).toEqual({ outcome: "ok", output: "Looked at the screen.", truncated: false, screen });
      computer.socket.close();
      await computer.closed;
    });

    it("sends a computerd that names no tools every tool from before the announcement", async () => {
      const computer = await connectComputer();
      const pending = link.call(callArgs("a:older"));
      await until(() => computer.received.some((message) => message.kind === "toolCall"));
      answer(computer, "a:older", "read");
      expect((await pending).output).toBe("read");
      computer.socket.close();
      await computer.closed;
    });
  });

  describe("a logged-out call", () => {
    const browsing: Browsing = { kind: "loggedOut", key: "run-1" };
    const snapshot: ToolInvocation = { name: "browser_snapshot", args: {} };

    it.each([
      ["a chat call", undefined, ""],
      ["a read-only run's browser call", browsing, ',"browsing":{"kind":"loggedOut","key":"run-1"}'],
    ] as const)("sends the exact bytes for %s, because a computerd from before this field closes its link on a field it does not know", async (_name, field, bytes) => {
      const computer = await connectComputer();
      await until(() => computer.received.some((message) => message.kind === "welcome"));
      const raw = new Promise<string>((resolve) => computer.socket.once("message", (data: Buffer) => resolve(data.toString())));
      const call = link.call({ ...callArgs("run:bytes"), tool: snapshot, browsing: field });
      expect(await raw).toBe(`{"kind":"toolCall","callId":"run:bytes","botId":"bot","tool":{"name":"browser_snapshot","args":{}}${bytes}}`);
      answer(computer, "run:bytes", "done");
      await call;
      computer.socket.close();
      await computer.closed;
    });

    it("ends as unavailable, with one send, when a computerd refuses the field and closes its link", async () => {
      const computer = await connectComputer();
      const call = link.call({ ...callArgs("run:older"), tool: snapshot, browsing });
      await until(() => computer.received.some((message) => message.kind === "toolCall"));
      computer.socket.close(LINK_CLOSE.invalidMessage);
      await computer.closed;
      const reconnected = await connectComputer();
      expect(await call).toMatchObject({ outcome: "unavailable" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(reconnected.received.some((message) => message.kind === "toolCall")).toBe(false);
      reconnected.socket.close();
      await reconnected.closed;
    });

    it("says cancelled, not unavailable, for a run that was stopped as the computerd refused the field", async () => {
      const computer = await connectComputer();
      const abort = new AbortController();
      const call = link.call({ ...callArgs("run:older-cancel", { cancel: abort.signal }), tool: snapshot, browsing });
      await until(() => computer.received.some((message) => message.kind === "toolCall"));
      abort.abort();
      computer.socket.close(LINK_CLOSE.invalidMessage);
      await computer.closed;
      expect(await call).toMatchObject({ outcome: "cancelled" });
    });

    it("retries after a link that dropped for another reason, so a restart of computerd keeps its journal's answer", async () => {
      const first = await connectComputer();
      const call = link.call({ ...callArgs("run:restart"), tool: snapshot, browsing });
      await until(() => first.received.some((message) => message.kind === "toolCall"));
      first.socket.close();
      await first.closed;
      const second = await connectComputer();
      await until(() => second.received.some((message) => message.kind === "toolCall"));
      expect(second.received.find((message) => message.kind === "toolCall")).toMatchObject({ callId: "run:restart", browsing });
      answer(second, "run:restart", "replayed");
      expect((await call).output).toBe("replayed");
      second.socket.close();
      await second.closed;
    });

    it("retries a chat call after the same close, so a computerd that refuses another bot's field does not fail a chat", async () => {
      const first = await connectComputer();
      const call = link.call(callArgs("run:neighbour"));
      await until(() => first.received.some((message) => message.kind === "toolCall"));
      first.socket.close(LINK_CLOSE.invalidMessage);
      await first.closed;
      const second = await connectComputer();
      await until(() => second.received.some((message) => message.kind === "toolCall"));
      answer(second, "run:neighbour", "still here");
      expect((await call).output).toBe("still here");
      second.socket.close();
      await second.closed;
    });

    it("sends browsingEnd on the open link, and nothing when no computer is there", async () => {
      link.sendBrowsingEnd({ ownerId: OWNER, botId: "bot", browsing });
      const computer = await connectComputer();
      link.sendBrowsingEnd({ ownerId: OWNER, botId: "bot", browsing });
      await until(() => computer.received.some((message) => message.kind === "browsingEnd"));
      expect(computer.received.filter((message) => message.kind === "browsingEnd")).toEqual([{ kind: "browsingEnd", botId: "bot", key: "run-1" }]);
      computer.socket.close();
      await computer.closed;
    });
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

describe("streams", () => {
  const openSocket = async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((resolve) => socket.once("open", resolve));
    return socket;
  };
  const closeCode = (socket: WebSocket) => new Promise<number>((resolve) => socket.once("close", resolve));
  const screenOpenFrom = (computer: Computer) => computer.received.filter((message) => message.kind === "screenOpen");

  it("opens a stream only when the computer dials back with its token", async () => {
    const computer = await connectComputer();
    const pending = link.openStream({ ownerId: OWNER, botId: "bot", mode: "watch" });
    await until(() => screenOpenFrom(computer).length === 1);
    const opened = screenOpenFrom(computer)[0];
    if (opened?.kind !== "screenOpen") {
      throw new Error("no screenOpen");
    }
    expect(opened.botId).toBe("bot");
    const dial = await openSocket();
    const welcome = new Promise((resolve) => dial.once("message", resolve));
    dial.send(JSON.stringify({ kind: "streamHello", token: "good", streamId: opened.streamId }));
    await welcome;
    const stream = await pending;
    expect(stream).toBeInstanceOf(WebSocket);
    dial.close();
    computer.socket.close();
    await computer.closed;
  });

  it.each([
    ["watch", ""],
    ["control", ',"mode":"control"'],
  ] as const)("sends the exact bytes for a %s stream, because a computerd from before modes closes its link on a field it does not know", async (mode, field) => {
    const computer = await connectComputer();
    const raw = new Promise<string>((resolve) => computer.socket.once("message", (data: Buffer) => resolve(data.toString())));
    const pending = link.openStream({ ownerId: OWNER, botId: "bot", mode });
    const text = await raw;
    const { streamId } = JSON.parse(text) as { streamId: string };
    expect(text).toBe(`{"kind":"screenOpen","streamId":"${streamId}","botId":"bot"${field}}`);
    const dial = await openSocket();
    dial.send(JSON.stringify({ kind: "streamHello", token: "good", streamId }));
    await pending;
    dial.close();
    computer.socket.close();
    await computer.closed;
  });

  it("refuses a stream nobody asked for", async () => {
    const dial = await openSocket();
    dial.send(JSON.stringify({ kind: "streamHello", token: "good", streamId: "made-up" }));
    expect(await closeCode(dial)).toBe(LINK_CLOSE.invalidMessage);
  });

  it("refuses the right stream with a wrong token, and keeps it open for the real computer", async () => {
    const computer = await connectComputer();
    const pending = link.openStream({ ownerId: OWNER, botId: "bot", mode: "watch" });
    await until(() => screenOpenFrom(computer).length === 1);
    const opened = screenOpenFrom(computer)[0];
    if (opened?.kind !== "screenOpen") {
      throw new Error("no screenOpen");
    }
    const impostor = await openSocket();
    impostor.send(JSON.stringify({ kind: "streamHello", token: "wrong", streamId: opened.streamId }));
    expect(await closeCode(impostor)).toBe(LINK_CLOSE.unauthorized);

    const dial = await openSocket();
    dial.send(JSON.stringify({ kind: "streamHello", token: "good", streamId: opened.streamId }));
    expect(await pending).toBeInstanceOf(WebSocket);
    dial.close();
    computer.socket.close();
    await computer.closed;
  });

  it("reports no computer for an owner with none", async () => {
    expect(await link.openStream({ ownerId: "nobody" as Id<"users">, botId: "bot", mode: "watch" })).toBe("no-computer");
  });
});

