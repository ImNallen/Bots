import { computerOfOwner, requireComputerAvailable } from "./computers.js";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { capText } from "./activity.js";
import { requireIdentity } from "./identity.js";
import { endRunsPastDeadline } from "./runEnd.js";
import { parseRoutineText, routineTitle } from "./routineText.js";
import { FALLBACK_ZONE, describeCadence, nextFireAfter, parseCadence } from "./scheduleTime.js";
import { activeRunOfBot, publicState, purgeRunBatch, purgeThreadBatch } from "./threads.js";
import type { Cadence, RunEventBody, RunState, ScheduleCall } from "./validators.js";

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
const MAX_PAUSE_REASON_LENGTH = 500;
const RECENT_RUNS_SHOWN = 5;
const KEEP_RUNS = 20;
export const EARLIER_REPORTS = 3;
export const UNDO_MS = 8000;

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

// A run stays until a day after it ended, because the limit on scheduled runs a day counts these rows by when they were created,
// and a run ends after it is created. A run with no end is still active.
export function runToPurge<Run extends { state: RunState; endedAt?: number | undefined; quiet?: true | undefined }>(newestFirst: readonly Run[], now: number): Run | null {
  let reported = 0;
  for (const [index, run] of newestFirst.entries()) {
    const reports = run.state.kind === "done" && run.quiet !== true;
    const keptForReports = reports && reported < EARLIER_REPORTS;
    reported += reports ? 1 : 0;
    if (index >= KEEP_RUNS && !keptForReports && run.endedAt !== undefined && now - run.endedAt > DAY_MS) {
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

type Lifecycle = Pick<Doc<"schedules">, "botId" | "nextFireAt" | "deleting">;

export function isLive(routine: Pick<Doc<"schedules">, "deleting">): boolean {
  return routine.deleting === undefined;
}

// A deleted routine has no nextFireAt, so fireDue never reads it, and it keeps the time it had for an undo.
export function softDeleted(routine: Lifecycle, now: number): Pick<Doc<"schedules">, "nextFireAt" | "deleting"> {
  return { nextFireAt: undefined, deleting: { until: now + UNDO_MS, ...(routine.nextFireAt === undefined ? {} : { nextFireAt: routine.nextFireAt }) } };
}

// An undo puts back the time the routine had, so an everyHours routine keeps its place. A time that passed during the undo window
// is at most seconds late, and the next tick fires it.
export function restored(routine: Lifecycle): Pick<Doc<"schedules">, "nextFireAt" | "deleting"> {
  return { nextFireAt: routine.deleting?.nextFireAt, deleting: undefined };
}

// A routine that was restored, or deleted again with a later end, is not this delete's to finish.
export function hardDeleteDue(routine: Lifecycle | null, now: number): boolean {
  return routine?.deleting !== undefined && routine.deleting.until <= now;
}

export function routineOfBot<Routine extends Lifecycle>(routine: Routine | null, botId: Id<"bots">): Routine | null {
  return routine !== null && routine.botId === botId && isLive(routine) ? routine : null;
}

export function retimed(routine: Lifecycle, cadence: Cadence, timeZone: string, now: number): Pick<Doc<"schedules">, "cadence" | "nextFireAt"> {
  return { cadence, nextFireAt: routine.nextFireAt === undefined ? undefined : nextFireAfter(cadence, timeZone, now) };
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
  await requireComputerAvailable(ctx, ownerId);
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
  const computer = await computerOfOwner(ctx, schedule.ownerId);
  if (computer?.reset !== undefined || computer?.desiredVm?.removing === true) {
    await ctx.db.patch(schedule._id, { nextFireAt: nextFireAfter(schedule.cadence, await zoneOfOwner(ctx, schedule.ownerId), now), lastMissed: { at: scheduledFor, reason: "The computer is resetting" } });
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

const SCHEDULE_TOOLS: Record<ScheduleCall["kind"], string> = {
  scheduleCreate: "schedule_create",
  scheduleUpdate: "schedule_update",
  scheduleDelete: "schedule_delete",
};

const NO_ZONE = "Your owner has no time zone set, so nothing changed. Ask them to set one in Settings, under General, and then to ask you again.";
const BAD_CADENCE =
  "This schedule is not one a routine can have, so nothing changed. A weekly routine needs its weekdays, an hour, and a minute. An everyHours routine needs 1 to 24 whole hours.";
const NO_SUCH_ROUTINE = "You have no routine with that id, so nothing changed. Your system prompt lists your routines.";

async function softDeleteRoutine(ctx: MutationCtx, routine: Doc<"schedules">, now: number): Promise<"deleted" | "running"> {
  if ((await activeRunOfBot(ctx, routine.botId))?.scheduleId === routine._id) {
    return "running";
  }
  const patch = softDeleted(routine, now);
  await ctx.db.patch(routine._id, patch);
  await ctx.scheduler.runAt(patch.deleting?.until ?? now, internal.schedules.finishDelete, { scheduleId: routine._id });
  return "deleted";
}

function whenWords(routine: Pick<Doc<"schedules">, "cadence" | "nextFireAt">, timeZone: string): string {
  const next = routine.nextFireAt === undefined ? "It is paused." : `Next run: ${new Date(routine.nextFireAt).toISOString()}.`;
  return `When: ${describeCadence(routine.cadence, timeZone)}. ${next}`;
}

// A routine outlives the run that made it, so Convex checks every change here, in the same mutation that writes it.
export async function applyScheduleCall(ctx: MutationCtx, run: Doc<"runs">, call: ScheduleCall): Promise<Extract<RunEventBody, { kind: "toolResult" }>> {
  const result = (outcome: "ok" | "error" | "cancelled" | "rejected", output: string) => ({
    kind: "toolResult" as const,
    toolCallId: call.toolCallId,
    name: SCHEDULE_TOOLS[call.kind],
    outcome,
    output,
    truncated: false,
  });
  if (run.capability !== "full") {
    return result("rejected", "This run is read-only, so it cannot change your routines, and this call did not run.");
  }
  if (run.cancelRequested) {
    return result("cancelled", "The run was cancelled before this call changed your routines, so it did not run.");
  }
  // The runner asks only at some levels and after untrusted text. When it did ask, only an approved answer for this tool counts.
  const approval = await ctx.db
    .query("approvals")
    .withIndex("by_run_call", (q) => q.eq("runId", run._id).eq("toolCallId", call.toolCallId))
    .unique();
  if (approval !== null && (approval.state !== "approved" || approval.toolName !== SCHEDULE_TOOLS[call.kind])) {
    return result("error", "Your owner did not approve this, so nothing changed.");
  }
  const timeZone = (await ctx.db.get(run.ownerId))?.timeZone;
  const now = Date.now();
  switch (call.kind) {
    case "scheduleCreate": {
      if (timeZone === undefined) {
        return result("error", NO_ZONE);
      }
      const text = parseRoutineText({ title: call.title, summary: call.summary, steps: call.steps, instruction: call.instruction });
      if (text.kind === "refused") {
        return result("error", `${text.reason} Nothing was created.`);
      }
      const cadence = parseCadence(call.cadence);
      if (cadence === null) {
        return result("error", BAD_CADENCE);
      }
      const ofOwner = (
        await ctx.db
          .query("schedules")
          .withIndex("by_owner", (q) => q.eq("ownerId", run.ownerId))
          .collect()
      ).filter(isLive);
      if (ofOwner.length >= MAX_ROUTINES_PER_OWNER) {
        return result("error", `Your owner already has ${MAX_ROUTINES_PER_OWNER} routines, so nothing was created. Delete one with schedule_delete if they ask you to.`);
      }
      if (ofOwner.filter((schedule) => schedule.botId === run.botId).length >= MAX_ROUTINES_PER_BOT) {
        return result("error", `You already have ${MAX_ROUTINES_PER_BOT} routines, so nothing was created. Change one with schedule_update, or delete one if your owner asks you to.`);
      }
      const nextFireAt = nextFireAfter(cadence, timeZone, now);
      const threadId = await ctx.db.insert("threads", { botId: run.botId, ownerId: run.ownerId, kind: "routine" });
      const scheduleId = await ctx.db.insert("schedules", { ownerId: run.ownerId, botId: run.botId, threadId, ...text.text, cadence, nextFireAt });
      return result("ok", `Created routine ${scheduleId}, titled ${JSON.stringify(text.text.title)}. ${whenWords({ cadence, nextFireAt }, timeZone)} Your owner sees it in your info panel.`);
    }
    case "scheduleUpdate": {
      const scheduleId = ctx.db.normalizeId("schedules", call.routineId);
      const routine = routineOfBot(scheduleId === null ? null : await ctx.db.get(scheduleId), run.botId);
      if (routine === null) {
        return result("error", NO_SUCH_ROUTINE);
      }
      const { kind: _kind, toolCallId: _toolCallId, routineId: _routineId, cadence: rawCadence, ...changes } = call;
      if (rawCadence === undefined && Object.values(changes).every((value) => value === undefined)) {
        return result("error", "Name at least one thing to change, so nothing changed.");
      }
      const text = parseRoutineText(changes);
      if (text.kind === "refused") {
        return result("error", `${text.reason} Nothing changed.`);
      }
      let timing = {};
      if (rawCadence !== undefined) {
        const cadence = parseCadence(rawCadence);
        if (cadence === null) {
          return result("error", BAD_CADENCE);
        }
        if (timeZone === undefined) {
          return result("error", NO_ZONE);
        }
        timing = retimed(routine, cadence, timeZone, now);
      }
      await ctx.db.patch(routine._id, { ...text.text, ...timing });
      const updated = { ...routine, ...text.text, ...timing };
      return result("ok", `Updated routine ${routine._id}, titled ${JSON.stringify(routineTitle(updated))}. ${whenWords(updated, timeZone ?? FALLBACK_ZONE)}`);
    }
    case "scheduleDelete": {
      const scheduleId = ctx.db.normalizeId("schedules", call.routineId);
      const routine = routineOfBot(scheduleId === null ? null : await ctx.db.get(scheduleId), run.botId);
      if (routine === null) {
        return result("error", NO_SUCH_ROUTINE);
      }
      if ((await softDeleteRoutine(ctx, routine, now)) === "running") {
        return result("error", "This routine is running now, so it was not deleted.");
      }
      return result("ok", `Deleted routine ${routine._id}, titled ${JSON.stringify(routineTitle(routine))}. Your owner can undo this in your info panel for ${UNDO_MS / 1000} seconds.`);
    }
  }
}

async function requireOwnedSchedule(ctx: QueryCtx, scheduleId: Id<"schedules">): Promise<Doc<"schedules">> {
  const { user } = await requireIdentity(ctx);
  const schedule = await ctx.db.get(scheduleId);
  if (user === null || schedule === null || schedule.ownerId !== user._id) {
    throw new ConvexError("Routine not found");
  }
  return schedule;
}

async function requireLiveSchedule(ctx: QueryCtx, scheduleId: Id<"schedules">): Promise<Doc<"schedules">> {
  const schedule = await requireOwnedSchedule(ctx, scheduleId);
  if (!isLive(schedule)) {
    throw new ConvexError("Routine not found");
  }
  return schedule;
}

// Every routine of the bot, deleted ones too, because deleting a bot takes them all.
export async function routinesOfBot(ctx: QueryCtx, botId: Id<"bots">): Promise<Doc<"schedules">[]> {
  return await ctx.db
    .query("schedules")
    .withIndex("by_bot", (q) => q.eq("botId", botId))
    .collect();
}

export function promptRoutines(routines: readonly Doc<"schedules">[], timeZone: string | undefined) {
  return routines.filter(isLive).map((routine) => ({
    id: routine._id,
    title: routineTitle(routine),
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
      undoMs: UNDO_MS,
      timeZone: user.timeZone,
      routines: await Promise.all(
        routines.toReversed().map(async (routine) =>
          routine.deleting === undefined
            ? {
                kind: "live" as const,
                _id: routine._id,
                title: routineTitle(routine),
                summary: routine.summary,
                steps: routine.steps,
                cadence: routine.cadence,
                nextFireAt: routine.nextFireAt,
                pausedBecause: routine.pausedBecause,
                lastMissed: routine.lastMissed,
                recentRuns: (await newestRunsOf(ctx, routine._id, RECENT_RUNS_SHOWN)).map((run) => ({
                  _id: run._id,
                  createdAt: run._creationTime,
                  state: publicState(run.state),
                })),
              }
            : { kind: "deleted" as const, _id: routine._id, title: routineTitle(routine), deletingUntil: routine.deleting.until },
        ),
      ),
    };
  },
});

export const pause = mutation({
  args: { scheduleId: v.id("schedules") },
  handler: async (ctx, { scheduleId }) => {
    await requireLiveSchedule(ctx, scheduleId);
    await ctx.db.patch(scheduleId, { nextFireAt: undefined });
  },
});

export const resume = mutation({
  args: { scheduleId: v.id("schedules") },
  handler: async (ctx, { scheduleId }) => {
    const schedule = await requireLiveSchedule(ctx, scheduleId);
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

export const remove = mutation({
  args: { scheduleId: v.id("schedules") },
  handler: async (ctx, { scheduleId }) => {
    const schedule = await requireOwnedSchedule(ctx, scheduleId);
    if (!isLive(schedule)) {
      return;
    }
    if ((await softDeleteRoutine(ctx, schedule, Date.now())) === "running") {
      throw new ConvexError("This routine is running. Stop it before you delete it");
    }
  },
});

export const restore = mutation({
  args: { scheduleId: v.id("schedules") },
  handler: async (ctx, { scheduleId }) => {
    const { user } = await requireIdentity(ctx);
    const schedule = await ctx.db.get(scheduleId);
    if (user === null || schedule === null || schedule.ownerId !== user._id) {
      throw new ConvexError("This routine is already gone");
    }
    if (!isLive(schedule)) {
      await ctx.db.patch(scheduleId, restored(schedule));
    }
  },
});

export const finishDelete = internalMutation({
  args: { scheduleId: v.id("schedules") },
  handler: async (ctx, { scheduleId }) => {
    const schedule = await ctx.db.get(scheduleId);
    if (schedule !== null && hardDeleteDue(schedule, Date.now())) {
      await ctx.db.delete(scheduleId);
      await ctx.scheduler.runAfter(0, internal.schedules.purgeThread, { threadId: schedule.threadId });
    }
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
