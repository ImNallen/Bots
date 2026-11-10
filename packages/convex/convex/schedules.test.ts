import { describe, expect, it } from "vitest";
import type { Doc, Id } from "./_generated/dataModel.js";
import { actOnDue, decideFire, hardDeleteDue, isLive, promptRoutines, restored, retimed, routineOfBot, runToPurge, softDeleted, UNDO_MS, type FireDecision } from "./schedules.js";
import { nextFireAfter } from "./scheduleTime.js";
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

describe("actOnDue", () => {
  const act = async (due: readonly ("wait" | "act")[], limit: number) => {
    const seen: number[] = [];
    await actOnDue(
      [...due.keys()],
      async (index) => {
        seen.push(index);
        return due[index] === "wait" ? "waited" : "acted";
      },
      limit,
    );
    return seen;
  };

  it("reaches a routine behind more waiting routines than the limit", async () => {
    const seen = await act([...Array.from({ length: 32 }, () => "wait" as const), "act"], 32);
    expect(seen.at(-1)).toBe(32);
  });

  it("stops once it has acted on the limit", async () => {
    expect(await act(["act", "wait", "act", "act"], 2)).toEqual([0, 1, 2]);
  });
});

describe("runToPurge", () => {
  const NOW = 10 * 24 * 60 * 60 * 1000;
  const OLD = 0;
  const runs = (...states: RunState[]) => states.map((state, index) => ({ state, index, endedAt: OLD }));
  const many = (count: number, state: RunState) => Array.from({ length: count }, () => state);

  it("keeps the newest 20 runs", () => {
    expect(runToPurge(runs(...many(20, DONE)), NOW)).toBeNull();
    expect(runToPurge(runs(...many(21, DONE)), NOW)?.index).toBe(20);
    expect(runToPurge(runs(...many(21, FAILED)), NOW)?.index).toBe(20);
  });

  it("keeps the newest 3 finished runs past the 20, because a routine reads its earlier reports from them", () => {
    const failedThenDone = runs(...many(20, FAILED), DONE, DONE, DONE, DONE);
    expect(runToPurge(failedThenDone, NOW)?.index).toBe(23);
    expect(runToPurge(failedThenDone.slice(0, 23), NOW)).toBeNull();
  });

  it("counts finished runs inside the 20 toward those 3", () => {
    expect(runToPurge(runs(DONE, DONE, DONE, ...many(17, FAILED), DONE), NOW)?.index).toBe(20);
  });

  it("keeps every run until a day after it ended, because the daily limit counts them", () => {
    const today = many(49, DONE).map((state, index) => ({ state, index, endedAt: NOW - 1000 }));
    expect(runToPurge(today, NOW)).toBeNull();
    expect(runToPurge(today, NOW + 24 * 60 * 60 * 1000)?.index).toBe(20);
  });

  it("keeps a run that has not ended", () => {
    const active = many(25, DONE).map((state, index) => ({ state, index }));
    expect(runToPurge(active, NOW)).toBeNull();
  });

  it("purges a failed run past the 20 even when finished runs are older", () => {
    expect(runToPurge(runs(...many(20, FAILED), FAILED, DONE), NOW)?.index).toBe(20);
  });
});

describe("a routine's delete", () => {
  const BOT = "bot" as Id<"bots">;
  const DAILY = { kind: "weekly" as const, weekdays: [0, 1, 2, 3, 4, 5, 6], hour: 10, minute: 0 };
  const routine = (fields: Partial<Doc<"schedules">> = {}): Doc<"schedules"> => ({
    _id: "routine" as Id<"schedules">,
    _creationTime: 0,
    ownerId: "owner" as Id<"users">,
    botId: BOT,
    threadId: "thread" as Id<"threads">,
    instruction: "Read the news and report.",
    title: "News",
    cadence: DAILY,
    nextFireAt: NOW + 60 * MINUTE,
    ...fields,
  });
  const deleteAt = (target: Doc<"schedules">, now = NOW) => ({ ...target, ...softDeleted(target, now) });

  it("never fires while it can be undone, because it has no next time", () => {
    const deleted = deleteAt(routine());
    expect(deleted.nextFireAt).toBeUndefined();
    expect(deleted.deleting).toEqual({ until: NOW + UNDO_MS, nextFireAt: NOW + 60 * MINUTE });
  });

  it("counts for nothing, is left out of the prompt, and no bot can change it", () => {
    const deleted = deleteAt(routine());
    expect([routine(), deleted].filter(isLive)).toHaveLength(1);
    expect(promptRoutines([routine({ _id: "kept" as Id<"schedules"> }), deleted], "UTC").map((row) => row.id)).toEqual(["kept"]);
    expect(routineOfBot(deleted, BOT)).toBeNull();
  });

  it("comes back with the time it had on an undo", () => {
    expect(restored(deleteAt(routine()))).toEqual({ deleting: undefined, nextFireAt: NOW + 60 * MINUTE });
  });

  it("stays paused on an undo if it was paused", () => {
    expect(restored(deleteAt(routine({ nextFireAt: undefined })))).toEqual({ deleting: undefined, nextFireAt: undefined });
  });

  it("goes for good only once its undo window has ended", () => {
    const deleted = deleteAt(routine());
    expect(hardDeleteDue(deleted, NOW + UNDO_MS - 1)).toBe(false);
    expect(hardDeleteDue(deleted, NOW + UNDO_MS)).toBe(true);
  });

  it("is not taken by an earlier delete's end after an undo, or after a second delete", () => {
    const undone = { ...deleteAt(routine()), ...restored(deleteAt(routine())) };
    expect(hardDeleteDue(undone, NOW + UNDO_MS)).toBe(false);
    const deletedAgain = deleteAt(undone, NOW + 5000);
    expect(hardDeleteDue(deletedAgain, NOW + UNDO_MS)).toBe(false);
    expect(hardDeleteDue(deletedAgain, NOW + 5000 + UNDO_MS)).toBe(true);
    expect(hardDeleteDue(null, NOW + UNDO_MS)).toBe(false);
  });
});

describe("a bot's routines", () => {
  const routine = { botId: "mine" as Id<"bots">, nextFireAt: NOW, deleting: undefined };

  it("are its own, so a bot cannot reach another bot's routine", () => {
    expect(routineOfBot(routine, "mine" as Id<"bots">)).toBe(routine);
    expect(routineOfBot(routine, "other" as Id<"bots">)).toBeNull();
    expect(routineOfBot(null, "mine" as Id<"bots">)).toBeNull();
  });

  it("count the next time from now under a new cadence, and a paused one stays paused", () => {
    const sixHours = { kind: "everyHours" as const, hours: 6 };
    expect(retimed(routine, sixHours, "Europe/Stockholm", NOW)).toEqual({ cadence: sixHours, nextFireAt: nextFireAfter(sixHours, "Europe/Stockholm", NOW) });
    expect(retimed({ ...routine, nextFireAt: undefined }, sixHours, "Europe/Stockholm", NOW)).toEqual({ cadence: sixHours, nextFireAt: undefined });
  });
});
