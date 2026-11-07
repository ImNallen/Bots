import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { capText } from "./activity.js";
import { requireIdentity } from "./identity.js";
import { textProblem, type TextProblem } from "./memories.js";
import { endRunsPastDeadline } from "./runEnd.js";
import { FALLBACK_ZONE, describeCadence, nextFireAfter, parseCadence } from "./scheduleTime.js";
import { activeRunOfBot, publicState, purgeRunBatch, purgeThreadBatch } from "./threads.js";
import type { RunEventBody, RunState, ScheduleCreate } from "./validators.js";

const RUN_LIMIT_MS = 30 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const FIRE_GRACE_MS = 15 * 60 * 1000;
const QUIET_AFTER_A_RUN_MS = 2 * 60 * 1000;
const DUE_PER_TICK = 32;
const DUE_READ_PER_TICK = 512;
const MAX_ROUTINES_PER_BOT = 10;
const MAX_ROUTINES_PER_OWNER = 20;
const MAX_SCHEDULED_RUNS_A_DAY = 48;
const FAILURES_THAT_PAUSE = 3;
const MAX_INSTRUCTION_LENGTH = 2000;
const MAX_PAUSE_REASON_LENGTH = 500;
const RECENT_RUNS_SHOWN = 5;
const KEEP_RUNS = 20;
export const EARLIER_REPORTS = 3;

const LIMIT_REASON = `You reached the limit of ${MAX_SCHEDULED_RUNS_A_DAY} routine runs in 24 hours`;
const BUSY_REASON = "The bot was busy for more than 15 minutes after this time";
const LATE_REASON = "Routines could not run at this time, for example because the server was off";

export type FireDecision = { kind: "wait" } | { kind: "miss"; reason: string } | { kind: "pause"; reason: string } | { kind: "fire" };

export function decideFire(args: {
  scheduledFor: number;
  now: number;
  busy: boolean;
  scheduledRunsInADay: number;
  newestRuns: readonly { createdAt: number; state: RunState }[];
  resumedAt: number | undefined;
}): FireDecision {
  const { scheduledFor, now, busy, scheduledRunsInADay, newestRuns, resumedAt } = args;
  if (now - scheduledFor > FIRE_GRACE_MS) {
    return { kind: "miss", reason: busy ? BUSY_REASON : LATE_REASON };
  }
  if (busy) {
    return { kind: "wait" };
  }
  if (scheduledRunsInADay >= MAX_SCHEDULED_RUNS_A_DAY) {
    return { kind: "miss", reason: LIMIT_REASON };
  }
  const counted = newestRuns.filter((run) => run.createdAt > (resumedAt ?? 0)).slice(0, FAILURES_THAT_PAUSE);
  const [newest] = counted;
  if (newest?.state.kind === "failed" && counted.length === FAILURES_THAT_PAUSE && counted.every((run) => run.state.kind === "failed")) {
    return {
      kind: "pause",
      reason: capText(`It paused itself after ${FAILURES_THAT_PAUSE} failed runs in a row. The last one said: ${newest.state.reason}`, MAX_PAUSE_REASON_LENGTH),
    };
  }
  return { kind: "fire" };
}

// A run stays for its first day whatever else holds, because the limit on scheduled runs a day counts these rows.
export function runToPurge<Run extends { state: RunState; _creationTime: number }>(newestFirst: readonly Run[], now: number): Run | null {
  let done = 0;
  for (const [index, run] of newestFirst.entries()) {
    const isDone = run.state.kind === "done";
    const keptForReports = isDone && done < EARLIER_REPORTS;
    done += isDone ? 1 : 0;
    if (index >= KEEP_RUNS && !keptForReports && now - run._creationTime > DAY_MS) {
      return run;
    }
  }
  return null;
}

// A routine that only waits changes nothing, so it must not use up a tick. Otherwise busy bots' routines would keep an idle bot's
// routine out of every tick until it was marked missed.
export async function actOnDue<Row>(due: readonly Row[], consider: (row: Row) => Promise<"waited" | "acted">, limit: number): Promise<void> {
  let acted = 0;
  for (const row of due) {
    if (acted === limit) {
      return;
    }
    if ((await consider(row)) === "acted") {
      acted += 1;
    }
  }
}

const RUNS_THAT_HOLD_A_PURGE = KEEP_RUNS + EARLIER_REPORTS + 1;

async function newestRunsOf(ctx: QueryCtx, scheduleId: Id<"schedules">, count: number): Promise<Doc<"runs">[]> {
  return await ctx.db
    .query("runs")
    .withIndex("by_schedule", (q) => q.eq("scheduleId", scheduleId))
    .order("desc")
    .take(count);
}

export async function startReadOnlyRun(ctx: MutationCtx, schedule: Doc<"schedules">, deadlineAt = Date.now() + RUN_LIMIT_MS): Promise<Id<"runs">> {
  const { threadId, botId, ownerId } = schedule;
  if ((await activeRunOfBot(ctx, botId)) !== null) {
    throw new ConvexError("This bot already has an active run");
  }
  const runId = await ctx.db.insert("runs", {
    threadId,
    botId,
    ownerId,
    trigger: "schedule",
    capability: "readOnly",
    scheduleId: schedule._id,
    deadlineAt,
    state: { kind: "queued" },
    cancelRequested: false,
    nextSeq: 1,
  });
  await ctx.db.insert("runEvents", {
    runId,
    threadId,
    seq: 0,
    body: { kind: "scheduleFired", scheduleId: schedule._id, text: schedule.instruction },
  });
  return runId;
}

async function fireRoutine(ctx: MutationCtx, schedule: Doc<"schedules">): Promise<Id<"runs">> {
  const runId = await startReadOnlyRun(ctx, schedule);
  if (runToPurge(await newestRunsOf(ctx, schedule._id, RUNS_THAT_HOLD_A_PURGE), Date.now()) !== null) {
    await ctx.scheduler.runAfter(0, internal.schedules.purgeOldRuns, { scheduleId: schedule._id });
  }
  return runId;
}

// A report's row has trigger schedule and no scheduleId, and it would count each fire twice.
async function scheduledRunsInADay(ctx: QueryCtx, ownerId: Id<"users">, now: number): Promise<number> {
  const runs = await ctx.db
    .query("runs")
    .withIndex("by_owner_trigger", (q) => q.eq("ownerId", ownerId).eq("trigger", "schedule").gt("_creationTime", now - DAY_MS))
    .filter((q) => q.neq(q.field("scheduleId"), undefined))
    .take(MAX_SCHEDULED_RUNS_A_DAY);
  return runs.length;
}

async function botIsBusy(ctx: QueryCtx, bot: Doc<"bots">, now: number): Promise<boolean> {
  if ((bot.takeoverUntil ?? 0) > now || (await activeRunOfBot(ctx, bot._id)) !== null) {
    return true;
  }
  const justEnded = await ctx.db
    .query("runs")
    .withIndex("by_bot_ended", (q) => q.eq("botId", bot._id).gt("endedAt", now - QUIET_AFTER_A_RUN_MS))
    .first();
  return justEnded !== null;
}

async function zoneOfOwner(ctx: QueryCtx, ownerId: Id<"users">): Promise<string> {
  return (await ctx.db.get(ownerId))?.timeZone ?? FALLBACK_ZONE;
}

async function considerDue(ctx: MutationCtx, schedule: Doc<"schedules">, scheduledFor: number, now: number): Promise<"waited" | "acted"> {
  const bot = await ctx.db.get(schedule.botId);
  if (bot === null) {
    await ctx.db.delete(schedule._id);
    return "acted";
  }
  const decision = decideFire({
    scheduledFor,
    now,
    busy: await botIsBusy(ctx, bot, now),
    scheduledRunsInADay: await scheduledRunsInADay(ctx, schedule.ownerId, now),
    newestRuns: (await newestRunsOf(ctx, schedule._id, FAILURES_THAT_PAUSE)).map((run) => ({ createdAt: run._creationTime, state: run.state })),
    resumedAt: schedule.resumedAt,
  });
  const nextTime = async () => nextFireAfter(schedule.cadence, await zoneOfOwner(ctx, schedule.ownerId), now);
  switch (decision.kind) {
    case "wait":
      return "waited";
    case "miss":
      await ctx.db.patch(schedule._id, { nextFireAt: await nextTime(), lastMissed: { at: scheduledFor, reason: decision.reason } });
      return "acted";
    case "pause":
      await ctx.db.patch(schedule._id, { nextFireAt: undefined, pausedBecause: decision.reason });
      return "acted";
    case "fire":
      await fireRoutine(ctx, schedule);
      await ctx.db.patch(schedule._id, { nextFireAt: await nextTime() });
      return "acted";
  }
}

export const fireDue = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    await endRunsPastDeadline(ctx, now);
    const due = await ctx.db
      .query("schedules")
      .withIndex("by_next_fire", (q) => q.gte("nextFireAt", 0).lte("nextFireAt", now))
      .take(DUE_READ_PER_TICK);
    await actOnDue(due, (schedule) => considerDue(ctx, schedule, schedule.nextFireAt ?? now, now), DUE_PER_TICK);
  },
});

export const purgeOldRuns = internalMutation({
  args: { scheduleId: v.id("schedules") },
  handler: async (ctx, { scheduleId }) => {
    const run = runToPurge(await newestRunsOf(ctx, scheduleId, RUNS_THAT_HOLD_A_PURGE), Date.now());
    if (run !== null) {
      await purgeRunBatch(ctx, run._id);
      await ctx.scheduler.runAfter(0, internal.schedules.purgeOldRuns, { scheduleId });
    }
  },
});

export const purgeThread = internalMutation({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    if ((await ctx.db.get(threadId)) !== null) {
      await purgeThreadBatch(ctx, threadId);
      await ctx.scheduler.runAfter(0, internal.schedules.purgeThread, { threadId });
    }
  },
});

export const INSTRUCTION_PROBLEMS: Record<TextProblem | "empty", string> = {
  empty: "A routine needs an instruction, so nothing was created.",
  tooLong: `A routine's instruction cannot be longer than ${MAX_INSTRUCTION_LENGTH.toLocaleString("en-US")} characters, so nothing was created. Write a shorter one.`,
  characters: "A routine's instruction cannot hold control characters or characters that change the text's direction, so nothing was created. Write it without them.",
  secret: "This looks like a password, key, token, or card number, so nothing was created. Do not try again. A routine browses logged out, so it needs no login.",
};

export function instructionProblem(instruction: string): TextProblem | "empty" | null {
  return instruction === "" ? "empty" : textProblem(instruction, MAX_INSTRUCTION_LENGTH);
}

export async function applyScheduleCreate(ctx: MutationCtx, run: Doc<"runs">, call: ScheduleCreate): Promise<Extract<RunEventBody, { kind: "toolResult" }>> {
  const result = (outcome: "ok" | "error" | "cancelled" | "rejected", output: string) => ({
    kind: "toolResult" as const,
    toolCallId: call.toolCallId,
    name: "schedule_propose",
    outcome,
    output,
    truncated: false,
  });
  if (run.capability !== "full") {
    return result("rejected", "This run is read-only, so it cannot create a routine, and this call did not run.");
  }
  if (run.cancelRequested) {
    return result("cancelled", "The run was cancelled before this call created a routine, so it did not run.");
  }
  const approval = await ctx.db
    .query("approvals")
    .withIndex("by_run_call", (q) => q.eq("runId", run._id).eq("toolCallId", call.toolCallId))
    .unique();
  if (approval?.state !== "approved" || approval.toolName !== "schedule_propose") {
    return result("error", "Your owner did not approve this routine, so nothing was created.");
  }
  const timeZone = (await ctx.db.get(run.ownerId))?.timeZone;
  if (timeZone === undefined) {
    return result("error", "Your owner has no time zone set, so nothing was created. Ask them to set one in Settings, under General, and then to ask you again.");
  }
  const instruction = call.instruction.trim();
  const problem = instructionProblem(instruction);
  if (problem !== null) {
    return result("error", INSTRUCTION_PROBLEMS[problem]);
  }
  const cadence = parseCadence(call.cadence);
  if (cadence === null) {
    return result("error", "This schedule is not one a routine can have, so nothing was created. A weekly routine needs its weekdays, an hour, and a minute. An everyHours routine needs 1 to 24 whole hours.");
  }
  const ofOwner = await ctx.db
    .query("schedules")
    .withIndex("by_owner", (q) => q.eq("ownerId", run.ownerId))
    .collect();
  if (ofOwner.length >= MAX_ROUTINES_PER_OWNER) {
    return result("error", `Your owner already has ${MAX_ROUTINES_PER_OWNER} routines, so nothing was created. They can delete one in a bot's info panel.`);
  }
  if (ofOwner.filter((schedule) => schedule.botId === run.botId).length >= MAX_ROUTINES_PER_BOT) {
    return result("error", `You already have ${MAX_ROUTINES_PER_BOT} routines, so nothing was created. Your owner can delete one in your info panel.`);
  }
  const nextFireAt = nextFireAfter(cadence, timeZone, Date.now());
  const threadId = await ctx.db.insert("threads", { botId: run.botId, ownerId: run.ownerId, kind: "routine" });
  const scheduleId = await ctx.db.insert("schedules", { ownerId: run.ownerId, botId: run.botId, threadId, instruction, cadence, nextFireAt });
  return result(
    "ok",
    `Created routine ${scheduleId}. When: ${describeCadence(cadence, timeZone)}. First run: ${new Date(nextFireAt).toISOString()}. Your owner can pause, test, and delete it in your info panel.`,
  );
}

async function requireOwnedSchedule(ctx: QueryCtx, scheduleId: Id<"schedules">): Promise<Doc<"schedules">> {
  const { user } = await requireIdentity(ctx);
  const schedule = await ctx.db.get(scheduleId);
  if (user === null || schedule === null || schedule.ownerId !== user._id) {
    throw new ConvexError("Routine not found");
  }
  return schedule;
}

export async function routinesOfBot(ctx: QueryCtx, botId: Id<"bots">): Promise<Doc<"schedules">[]> {
  return await ctx.db
    .query("schedules")
    .withIndex("by_bot", (q) => q.eq("botId", botId))
    .collect();
}

export function promptRoutines(routines: readonly Doc<"schedules">[], timeZone: string | undefined) {
  return routines.map((routine) => ({
    when: describeCadence(routine.cadence, timeZone ?? FALLBACK_ZONE),
    next: routine.nextFireAt === undefined ? "paused" : new Date(routine.nextFireAt).toISOString(),
    instruction: routine.instruction,
  }));
}

export const listForBot = query({
  args: { botId: v.id("bots") },
  handler: async (ctx, { botId }) => {
    const { user } = await requireIdentity(ctx);
    const bot = await ctx.db.get(botId);
    if (user === null || bot === null || bot.ownerId !== user._id) {
      return null;
    }
    const routines = await routinesOfBot(ctx, botId);
    return {
      limit: MAX_ROUTINES_PER_BOT,
      timeZone: user.timeZone,
      routines: await Promise.all(
        routines.toReversed().map(async (routine) => ({
          _id: routine._id,
          instruction: routine.instruction,
          cadence: routine.cadence,
          nextFireAt: routine.nextFireAt,
          pausedBecause: routine.pausedBecause,
          lastMissed: routine.lastMissed,
          recentRuns: (await newestRunsOf(ctx, routine._id, RECENT_RUNS_SHOWN)).map((run) => ({
            _id: run._id,
            createdAt: run._creationTime,
            state: publicState(run.state),
          })),
        })),
      ),
    };
  },
});

export const pause = mutation({
  args: { scheduleId: v.id("schedules") },
  handler: async (ctx, { scheduleId }) => {
    await requireOwnedSchedule(ctx, scheduleId);
    await ctx.db.patch(scheduleId, { nextFireAt: undefined });
  },
});

export const resume = mutation({
  args: { scheduleId: v.id("schedules") },
  handler: async (ctx, { scheduleId }) => {
    const schedule = await requireOwnedSchedule(ctx, scheduleId);
    if (schedule.nextFireAt !== undefined) {
      return;
    }
    const now = Date.now();
    await ctx.db.patch(scheduleId, {
      nextFireAt: nextFireAfter(schedule.cadence, await zoneOfOwner(ctx, schedule.ownerId), now),
      pausedBecause: undefined,
      resumedAt: now,
    });
  },
});

export const runNow = mutation({
  args: { scheduleId: v.id("schedules") },
  handler: async (ctx, { scheduleId }) => {
    const schedule = await requireOwnedSchedule(ctx, scheduleId);
    const now = Date.now();
    const bot = await ctx.db.get(schedule.botId);
    if ((bot?.takeoverUntil ?? 0) > now) {
      throw new ConvexError("Give back this bot's screen first");
    }
    if ((await scheduledRunsInADay(ctx, schedule.ownerId, now)) >= MAX_SCHEDULED_RUNS_A_DAY) {
      throw new ConvexError(LIMIT_REASON);
    }
    return await fireRoutine(ctx, schedule);
  },
});

export const remove = mutation({
  args: { scheduleId: v.id("schedules") },
  handler: async (ctx, { scheduleId }) => {
    const schedule = await requireOwnedSchedule(ctx, scheduleId);
    if ((await activeRunOfBot(ctx, schedule.botId))?.scheduleId === scheduleId) {
      throw new ConvexError("This routine is running. Stop it before you delete it");
    }
    await ctx.db.delete(scheduleId);
    await ctx.scheduler.runAfter(0, internal.schedules.purgeThread, { threadId: schedule.threadId });
  },
});

export async function followTimeZone(ctx: MutationCtx, ownerId: Id<"users">, timeZone: string, now: number): Promise<void> {
  const routines = await ctx.db
    .query("schedules")
    .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
    .collect();
  for (const routine of routines) {
    const stillAheadOnTheClock = routine.cadence.kind === "weekly" && routine.nextFireAt !== undefined && routine.nextFireAt > now;
    if (stillAheadOnTheClock) {
      await ctx.db.patch(routine._id, { nextFireAt: nextFireAfter(routine.cadence, timeZone, now) });
    }
  }
}
