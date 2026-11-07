import { describe, expect, it } from "vitest";
import { decideFire, instructionProblem, runToPurge, type FireDecision } from "./schedules.js";
import type { RunState } from "./validators.js";

const NOW = 1_000_000_000;
const MINUTE = 60_000;
const FAILED: RunState = { kind: "failed", reason: "No key." };
const DONE: RunState = { kind: "done" };
const CANCELLED: RunState = { kind: "cancelled" };

const decide = (overrides: Partial<Parameters<typeof decideFire>[0]> = {}): FireDecision =>
  decideFire({ scheduledFor: NOW, now: NOW, busy: false, scheduledRunsInADay: 0, newestRuns: [], resumedAt: undefined, ...overrides });

const ran = (state: RunState, createdAt = NOW - 60 * MINUTE) => ({ state, createdAt });

describe("decideFire", () => {
  it("fires a routine that is due, with an idle bot", () => {
    expect(decide()).toEqual({ kind: "fire" });
  });

  it("fires a routine 15 minutes late", () => {
    expect(decide({ scheduledFor: NOW - 15 * MINUTE })).toEqual({ kind: "fire" });
  });

  it("waits for a busy bot inside the 15 minutes", () => {
    expect(decide({ busy: true, scheduledFor: NOW - 15 * MINUTE })).toEqual({ kind: "wait" });
  });

  it("misses a fire more than 15 minutes late, with an idle bot, and starts no run", () => {
    expect(decide({ scheduledFor: NOW - 2 * 60 * MINUTE })).toEqual({ kind: "miss", reason: expect.stringMatching(/could not run/) });
  });

  it("misses a fire more than 15 minutes late, with a busy bot", () => {
    expect(decide({ busy: true, scheduledFor: NOW - 16 * MINUTE })).toEqual({ kind: "miss", reason: expect.stringMatching(/busy/) });
  });

  it("misses a fire at 48 scheduled runs in a day, and not at 47", () => {
    expect(decide({ scheduledRunsInADay: 48 })).toEqual({ kind: "miss", reason: expect.stringMatching(/limit of 48/) });
    expect(decide({ scheduledRunsInADay: 47 })).toEqual({ kind: "fire" });
  });

  it("pauses after the newest 3 runs failed, and quotes the last reason", () => {
    expect(decide({ newestRuns: [ran(FAILED), ran(FAILED), ran(FAILED)] })).toEqual({ kind: "pause", reason: expect.stringMatching(/3 failed runs in a row.*No key\./) });
  });

  it.each([
    ["two failures", [ran(FAILED), ran(FAILED)]],
    ["a success between them", [ran(FAILED), ran(DONE), ran(FAILED)]],
    ["a newest success", [ran(DONE), ran(FAILED), ran(FAILED), ran(FAILED)]],
    ["an owner's stop among them", [ran(FAILED), ran(CANCELLED), ran(FAILED)]],
  ])("does not pause after %s", (_label, newestRuns) => {
    expect(decide({ newestRuns })).toEqual({ kind: "fire" });
  });

  it("counts only failures after Resume, so a routine runs again once its cause is fixed", () => {
    const resumedAt = NOW - 10 * MINUTE;
    const before = [ran(FAILED), ran(FAILED), ran(FAILED)];
    expect(decide({ newestRuns: before, resumedAt })).toEqual({ kind: "fire" });
    expect(decide({ newestRuns: [ran(FAILED, NOW - MINUTE), ...before], resumedAt })).toEqual({ kind: "fire" });
    const after = [ran(FAILED, NOW - MINUTE), ran(FAILED, NOW - 2 * MINUTE), ran(FAILED, NOW - 3 * MINUTE)];
    expect(decide({ newestRuns: after, resumedAt })).toMatchObject({ kind: "pause" });
  });

  it("caps a long reason, because it is stored with the routine", () => {
    const long: RunState = { kind: "failed", reason: "x".repeat(4000) };
    const decision = decide({ newestRuns: [ran(long), ran(long), ran(long)] });
    expect(decision.kind === "pause" && decision.reason.length).toBe(500);
  });
});

describe("runToPurge", () => {
  const runs = (...states: RunState[]) => states.map((state, index) => ({ state, index }));
  const many = (count: number, state: RunState) => Array.from({ length: count }, () => state);

  it("keeps the newest 20 runs", () => {
    expect(runToPurge(runs(...many(20, DONE)))).toBeNull();
    expect(runToPurge(runs(...many(21, DONE)))?.index).toBe(20);
    expect(runToPurge(runs(...many(21, FAILED)))?.index).toBe(20);
  });

  it("keeps the newest 3 finished runs past the 20, because a routine reads its earlier reports from them", () => {
    const failedThenDone = runs(...many(20, FAILED), DONE, DONE, DONE, DONE);
    expect(runToPurge(failedThenDone)?.index).toBe(23);
    expect(runToPurge(failedThenDone.slice(0, 23))).toBeNull();
  });

  it("counts finished runs inside the 20 toward those 3", () => {
    expect(runToPurge(runs(DONE, DONE, DONE, ...many(17, FAILED), DONE))?.index).toBe(20);
  });

  it("purges a failed run past the 20 even when finished runs are older", () => {
    expect(runToPurge(runs(...many(20, FAILED), FAILED, DONE))?.index).toBe(20);
  });
});

describe("instructionProblem", () => {
  it("accepts up to 2,000 characters of plain text, with line breaks", () => {
    expect(instructionProblem(`Read the news.\n${"x ".repeat(992)}`)).toBeNull();
    expect(instructionProblem("y ".repeat(1000))).toBeNull();
  });

  it("uses the same rules as a note", () => {
    expect(instructionProblem("")).toBe("empty");
    expect(instructionProblem("z ".repeat(1001))).toBe("tooLong");
    expect(instructionProblem("a‮b")).toBe("characters");
    expect(instructionProblem("my password=hunter2")).toBe("secret");
  });
});
