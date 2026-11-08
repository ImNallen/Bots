import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolInvocation, ToolResult } from "@bots/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCalls, type ExecuteTool } from "./calls.ts";
import { openJournal } from "./journal.ts";

const tool: ToolInvocation = { name: "shell", args: { command: "true", timeoutSeconds: 1 } };
const request = { callId: "run1:call1", botId: "bot", tool };
const ok: ToolResult = { outcome: "ok", output: "done", exitCode: 0, truncated: false };

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "journal-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function counting(result: () => Promise<ToolResult> = async () => ok) {
  const counter = { runs: 0 };
  const execute: ExecuteTool = async () => {
    counter.runs += 1;
    return await result();
  };
  return { counter, execute };
}

describe("calls", () => {
  it("hands the tool how the call browses, so a logged-out call stays logged out", async () => {
    const seen: unknown[] = [];
    const execute: ExecuteTool = async ({ browsing }) => {
      seen.push(browsing);
      return ok;
    };
    const calls = createCalls({ journal: await openJournal({ dir }), execute });
    const browsing = { kind: "loggedOut", key: "run" } as const;
    await calls.call({ ...request, callId: "run:browsing", browsing });
    await calls.call({ ...request, callId: "run:chat" });
    expect(seen).toEqual([browsing, undefined]);
  });

  it("runs a new call once and replays its stored result", async () => {
    const { counter, execute } = counting();
    const calls = createCalls({ journal: await openJournal({ dir }), execute });
    expect(await calls.call(request)).toEqual(ok);
    expect(await calls.call(request)).toEqual(ok);
    expect(counter.runs).toBe(1);
  });

  it("journals a look without its picture, so the running call gets the picture and a repeat gets only the marks", async () => {
    const screen = { width: 1280, height: 800, windows: [], active: null, marks: [], unlisted: 0, silent: [] };
    const looked: ToolResult = { outcome: "ok", output: "Looked at the screen.", truncated: false, screen: { ...screen, image: { mediaType: "image/png", base64: "AAAA" } } };
    const { counter, execute } = counting(async () => looked);
    const calls = createCalls({ journal: await openJournal({ dir }), execute });
    const desktopRequest = { callId: "run:look", botId: "bot", tool: { name: "desktop_look" as const, args: {} } };
    expect(await calls.call(desktopRequest)).toEqual(looked);
    expect(await calls.call(desktopRequest)).toEqual({ ...looked, screen });
    expect(counter.runs).toBe(1);
  });

  it("replays across a process restart", async () => {
    const first = counting();
    await createCalls({ journal: await openJournal({ dir }), execute: first.execute }).call(request);
    const second = counting();
    const restarted = createCalls({ journal: await openJournal({ dir }), execute: second.execute });
    expect(await restarted.call(request)).toEqual(ok);
    expect(second.counter.runs).toBe(0);
  });

  it("attaches a second call to a running execution", async () => {
    const gate = Promise.withResolvers<ToolResult>();
    const { counter, execute } = counting(() => gate.promise);
    const calls = createCalls({ journal: await openJournal({ dir }), execute });
    const attempts = [calls.call(request), calls.call(request)];
    gate.resolve(ok);
    expect(await Promise.all(attempts)).toEqual([ok, ok]);
    expect(counter.runs).toBe(1);
  });

  it("records interrupted and never reruns a call whose process died", async () => {
    const journal = await openJournal({ dir });
    await journal.markStarted({ callId: request.callId, botId: "bot", toolName: "shell" });
    const { counter, execute } = counting();
    const calls = createCalls({ journal: await openJournal({ dir }), execute });
    const result = await calls.call(request);
    expect(result.outcome).toBe("interrupted");
    expect(result.output).toMatch(/may have partly run/);
    expect(await calls.call(request)).toEqual(result);
    expect(counter.runs).toBe(0);
  });

  it("writes meta before the tool starts", async () => {
    const journal = await openJournal({ dir });
    let entryDuringRun: unknown;
    const calls = createCalls({
      journal,
      execute: async () => {
        entryDuringRun = await journal.read(request.callId);
        return ok;
      },
    });
    await calls.call(request);
    expect(entryDuringRun).toEqual({ kind: "started" });
  });

  it("ignores a temp result left by a crash and reads the call as interrupted", async () => {
    const journal = await openJournal({ dir });
    await journal.markStarted({ callId: request.callId, botId: "bot", toolName: "shell" });
    const [meta] = await readdir(dir);
    await writeFile(join(dir, `${meta?.replace(".meta.json", "")}.result.json.tmp`), '{"partial');
    expect(await journal.read(request.callId)).toEqual({ kind: "started" });
  });

  it("cancels a running call through its signal", async () => {
    const calls = createCalls({
      journal: await openJournal({ dir }),
      execute: async ({ signal }) => {
        await new Promise((done) => signal.addEventListener("abort", done));
        return { outcome: "cancelled", output: "", truncated: false };
      },
    });
    const running = calls.call(request);
    await new Promise((done) => setTimeout(done, 20));
    expect((await calls.cancel(request.callId)).outcome).toBe("cancelled");
    expect((await running).outcome).toBe("cancelled");
  });

  it("cancelling before the start stops the call from ever running", async () => {
    const { counter, execute } = counting();
    const calls = createCalls({ journal: await openJournal({ dir }), execute });
    expect((await calls.cancel(request.callId)).outcome).toBe("cancelled");
    expect((await calls.call(request)).outcome).toBe("cancelled");
    expect(counter.runs).toBe(0);
  });

  it("cancelling a finished call returns what really happened", async () => {
    const { execute } = counting();
    const calls = createCalls({ journal: await openJournal({ dir }), execute });
    await calls.call(request);
    expect(await calls.cancel(request.callId)).toEqual(ok);
  });
});

describe("journal prune", () => {
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

  async function age(args: { byMs: number }): Promise<void> {
    const old = new Date(Date.now() - args.byMs);
    for (const name of await readdir(dir)) {
      await utimes(join(dir, name), old, old);
    }
  }

  it("never lets a pruned call run again", async () => {
    const journal = await openJournal({ dir });
    const { counter, execute } = counting();
    await createCalls({ journal, execute }).call(request);
    await age({ byMs: 2 * WEEK_MS });
    await journal.prune({ now: Date.now(), maxAgeMs: WEEK_MS });

    const replay = await createCalls({ journal, execute }).call(request);
    expect(replay.outcome).toBe("interrupted");
    expect(counter.runs).toBe(1);
  });

  it("never lets a call that died mid-run run again after a prune", async () => {
    const journal = await openJournal({ dir });
    await journal.markStarted({ callId: request.callId, botId: "bot", toolName: "shell" });
    await age({ byMs: 2 * WEEK_MS });
    await journal.prune({ now: Date.now(), maxAgeMs: WEEK_MS });

    const { counter, execute } = counting();
    const replay = await createCalls({ journal, execute }).call(request);
    expect(replay.outcome).toBe("interrupted");
    expect(counter.runs).toBe(0);
  });

  it("leaves a recent temp file alone, because a result may be mid-write", async () => {
    const journal = await openJournal({ dir });
    await writeFile(join(dir, "run1%3Acall1.result.json.tmp"), "partial");
    await journal.prune({ now: Date.now(), maxAgeMs: WEEK_MS });
    expect(await readdir(dir)).toContain("run1%3Acall1.result.json.tmp");
  });

  it("removes old results and old temp files and keeps recent ones", async () => {
    const journal = await openJournal({ dir });
    await journal.markStarted({ callId: "old:a", botId: "bot", toolName: "shell" });
    await journal.finish({ callId: "old:a", result: ok });
    const ancient = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    for (const name of await readdir(dir)) {
      await utimes(join(dir, name), ancient, ancient);
    }
    await journal.markStarted({ callId: "new:b", botId: "bot", toolName: "shell" });
    const pruned = await journal.prune({ now: Date.now(), maxAgeMs: 7 * 24 * 60 * 60 * 1000 });
    expect(pruned).toBe(1);
    expect(await journal.read("old:a")).toEqual({ kind: "started" });
    expect(await journal.read("new:b")).toEqual({ kind: "started" });
  });
});
