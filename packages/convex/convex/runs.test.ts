import { describe, expect, it } from "vitest";
import { finishedState } from "./runs.js";
import type { TerminalRunState } from "./validators.js";

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
