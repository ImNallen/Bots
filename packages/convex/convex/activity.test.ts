import { describe, expect, it } from "vitest";
import { decideActivity, lastMessageOf } from "./activity.js";
import type { RunEventBody, RunState } from "./validators.js";

const NOW = 1_000_000;
const RUNNING: RunState = { kind: "running", leaseToken: "lease", leaseUntil: NOW + 1000 };
const FAILED: RunState = { kind: "failed", reason: "It broke." };

const user = (text: string): RunEventBody => ({ kind: "userMessage", text });
const turn = (text: string, ...toolCalls: string[]): RunEventBody => ({
  kind: "assistantTurn",
  text,
  toolCalls: toolCalls.map((name) => ({ id: `id-${name}`, name, arguments: "{}" })),
  usage: { promptTokens: 1, completionTokens: 1 },
  model: "model",
});
const result = (name: string): RunEventBody => ({
  kind: "toolResult",
  toolCallId: `id-${name}`,
  name,
  outcome: "ok",
  output: "",
  truncated: false,
});

function activity(overrides: Partial<Parameters<typeof decideActivity>[0]>) {
  return decideActivity({
    hasPendingApproval: false,
    runState: null,
    newestEvents: [],
    ...overrides,
  });
}

describe("decideActivity", () => {
  it("is idle with no run, and after a run that ended without failing", () => {
    expect(activity({})).toEqual({ kind: "idle" });
    expect(activity({ runState: { kind: "done" } })).toEqual({ kind: "idle" });
    expect(activity({ runState: { kind: "cancelled" } })).toEqual({ kind: "idle" });
  });

  it("reports a queued run and a failed last run", () => {
    expect(activity({ runState: { kind: "queued" } })).toEqual({ kind: "queued" });
    expect(activity({ runState: FAILED })).toEqual({ kind: "failed" });
  });

  it("puts approval before the run", () => {
    expect(activity({ hasPendingApproval: true, runState: RUNNING })).toEqual({ kind: "needsApproval" });
    expect(activity({ runState: RUNNING }).kind).toBe("running");
  });

  it("ignores a pending approval left on a run that has ended", () => {
    expect(activity({ hasPendingApproval: true, runState: { kind: "cancelled" } })).toEqual({ kind: "idle" });
    expect(activity({ hasPendingApproval: true, runState: FAILED })).toEqual({ kind: "failed" });
  });

  it("names the first unanswered tool of the newest turn", () => {
    const newestEvents = [result("shell"), turn("", "shell", "read_file"), user("go")];
    expect(activity({ runState: RUNNING, newestEvents })).toEqual({ kind: "running", tool: "read_file" });
  });

  it("names no tool while the bot waits on the model", () => {
    const answered = [result("shell"), turn("", "shell"), user("go")];
    expect(activity({ runState: RUNNING, newestEvents: answered })).toEqual({ kind: "running", tool: null });
    expect(activity({ runState: RUNNING, newestEvents: [user("go")] })).toEqual({ kind: "running", tool: null });
  });
});

describe("lastMessageOf", () => {
  it("is null when there is no text", () => {
    expect(lastMessageOf([])).toBeNull();
    expect(lastMessageOf([result("shell"), turn("", "shell")])).toBeNull();
  });

  it("takes the newest user or assistant text and skips turns with none", () => {
    expect(lastMessageOf([turn("Done."), user("go")])).toBe("Done.");
    expect(lastMessageOf([result("shell"), turn("  ", "shell"), user("go")])).toBe("go");
  });

  it("puts a multi-line message on one line", () => {
    expect(lastMessageOf([turn("  First\n\n  second  ")])).toBe("First second");
  });

  it("caps at 140 characters without splitting an emoji", () => {
    expect(lastMessageOf([user("a".repeat(141))])).toBe("a".repeat(140));
    expect(lastMessageOf([user(`${"a".repeat(139)}😀`)])).toBe("a".repeat(139));
  });
});
