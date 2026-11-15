import { describe, expect, it } from "vitest";
import type { Id } from "./_generated/dataModel.js";
import { finishedState, noProgressReason, routineEnding } from "./runs.js";
import type { RunEventBody, TerminalRunState } from "./validators.js";

const NOW = 1_000_000;
const REASON = "The routine ran past its 30 minute limit";
const CANCELLED: TerminalRunState = { kind: "cancelled" };

describe("finishedState", () => {
  it("turns a stop past the deadline into a failure with its reason, when the owner did not press Stop", () => {
    const run = { cancelRequested: false, deadlineAt: NOW - 1 };
    expect(finishedState({ run, state: CANCELLED, now: NOW })).toEqual({ kind: "failed", reason: REASON });
  });

  it("keeps an owner's Stop as cancelled, also past the deadline", () => {
    const run = { cancelRequested: true, deadlineAt: NOW - 1 };
    expect(finishedState({ run, state: CANCELLED, now: NOW })).toEqual(CANCELLED);
  });

  it("does not count the deadline's own millisecond as past it", () => {
    const run = { cancelRequested: false, deadlineAt: NOW };
    expect(finishedState({ run, state: CANCELLED, now: NOW })).toEqual(CANCELLED);
  });

  it("leaves a run with no deadline alone", () => {
    const run = { cancelRequested: false, deadlineAt: undefined };
    expect(finishedState({ run, state: CANCELLED, now: NOW })).toEqual(CANCELLED);
  });

  it.each<TerminalRunState>([{ kind: "done" }, { kind: "failed", reason: "It broke." }])("keeps %j past the deadline, because the run ended by itself", (state) => {
    const run = { cancelRequested: false, deadlineAt: NOW - 1 };
    expect(finishedState({ run, state, now: NOW })).toEqual(state);
  });
});

describe("noProgressReason", () => {
  it("tells a chat's owner to send another message", () => {
    expect(noProgressReason({ scheduleId: undefined })).toMatch(/Send another message/);
  });

  it("tells a routine's owner that it tries again, because a routine has no message to send", () => {
    const reason = noProgressReason({ scheduleId: "s" as Id<"schedules"> });
    expect(reason).toMatch(/tries again at its next time/);
    expect(reason).not.toMatch(/Send another message/);
  });
});

describe("routineEnding", () => {
  const turn = (text: string, ...calls: { id: string; name: string; arguments: string }[]): RunEventBody => ({
    kind: "assistantTurn",
    text,
    toolCalls: calls,
    usage: { promptTokens: 1, completionTokens: 1 },
    model: "model",
  });
  const result = (toolCallId: string, name: string, outcome: "ok" | "rejected"): RunEventBody => ({
    kind: "toolResult",
    toolCallId,
    name,
    outcome,
    output: "",
    truncated: false,
  });
  const quietCall = { id: "q", name: "stay_quiet", arguments: JSON.stringify({ reason: "The price did not drop." }) };

  it("posts the last turn's text as the report", () => {
    expect(routineEnding([turn("  The price dropped to 90.  ")])).toEqual({ kind: "report", text: "The price dropped to 90." });
  });

  it("posts nothing for a stay_quiet that ran, even when its turn also has text", () => {
    expect(routineEnding([result("q", "stay_quiet", "ok"), turn("", quietCall)])).toEqual({ kind: "quiet" });
    expect(routineEnding([result("q", "stay_quiet", "ok"), turn("Still 120.", quietCall)])).toEqual({ kind: "quiet" });
  });

  it("fails an empty reply, because nothing tells it apart from a model that broke", () => {
    expect(routineEnding([turn("   ")])).toEqual({ kind: "noReport" });
    expect(routineEnding([])).toEqual({ kind: "noReport" });
  });

  it("reports from a final call whose stay_quiet was rejected, and fails one with no text", () => {
    expect(routineEnding([result("q", "stay_quiet", "rejected"), turn("Report anyway.", quietCall)])).toEqual({ kind: "report", text: "Report anyway." });
    expect(routineEnding([result("q", "stay_quiet", "rejected"), turn("", quietCall)])).toEqual({ kind: "noReport" });
  });

  it("caps a report at 8,000 characters", () => {
    expect(routineEnding([turn("a".repeat(8001))])).toEqual({ kind: "report", text: "a".repeat(8000) });
  });
});
