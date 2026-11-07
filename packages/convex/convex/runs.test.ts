import { describe, expect, it } from "vitest";
import type { Id } from "./_generated/dataModel.js";
import { finishedState, noProgressReason } from "./runs.js";
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
