import { paginationOptsValidator } from "convex/server";
import { ConvexError, v, type Infer } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel.js";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { computerOfOwner, requireComputerAvailable } from "./computers.js";
import { capText } from "./activity.js";
import { requireIdentity, requireService } from "./identity.js";
import { applyMemoryCall } from "./memories.js";
import { DEADLINE_FAILURE, closeUnansweredCalls, deleteStream, endPastDeadline, endRun, noRunnerHolds, pastDeadline } from "./runEnd.js";
import { EARLIER_REPORTS, applyScheduleCall } from "./schedules.js";
import { ensureChatThread } from "./threads.js";
import { keepScreen } from "./screens.js";
import { memoryCall, runEventBody, scheduleCall, terminalRunState, toolResultWithScreen, type RunEventBody, type TerminalRunState } from "./validators.js";

const LEASE_MS = 15_000;
const CLAIMABLE_PAGE = 64;
const MAX_CLAIMS_WITHOUT_PROGRESS = 5;
const NO_PROGRESS = `The run stopped after ${MAX_CLAIMS_WITHOUT_PROGRESS} attempts in a row failed with no progress.`;
const NO_REPORT_REASON = "The routine ended without a report";
const MAX_REPORT_LENGTH = 8000;

export function noProgressReason(run: Pick<Doc<"runs">, "scheduleId">): string {
  return `${NO_PROGRESS} ${run.scheduleId === undefined ? "Send another message to try again." : "The routine tries again at its next time."}`;
}

const fence = { runId: v.id("runs"), leaseToken: v.string() };
const appendBody = v.union(runEventBody, memoryCall, scheduleCall, toolResultWithScreen);

async function requireLease(
  ctx: MutationCtx,
  args: { runId: Id<"runs">; leaseToken: string },
): Promise<Doc<"runs">> {
  const run = await ctx.db.get(args.runId);
  if (run === null || run.state.kind !== "running" || run.state.leaseToken !== args.leaseToken) {
    throw new ConvexError("Lease lost");
  }
  await requireComputerAvailable(ctx, run.ownerId);
  return run;
}

export function finishedState(args: { run: Pick<Doc<"runs">, "cancelRequested" | "deadlineAt">; state: TerminalRunState; now: number }): TerminalRunState {
  const { run, state, now } = args;
  return state.kind === "cancelled" && !run.cancelRequested && pastDeadline(run, now) ? DEADLINE_FAILURE : state;
}

async function lastTurnTextOf(ctx: QueryCtx, runId: Id<"runs">): Promise<string | null> {
  for await (const { body } of ctx.db
    .query("runEvents")
    .withIndex("by_run_seq", (q) => q.eq("runId", runId))
    .order("desc")) {
    if (body.kind === "assistantTurn") {
      const text = capText(body.text.trim(), MAX_REPORT_LENGTH);
      return text === "" ? null : text;
    }
  }
  return null;
}

async function postReport(ctx: MutationCtx, run: Doc<"runs">, scheduleId: Id<"schedules">, text: string): Promise<void> {
  const threadId = await ensureChatThread(ctx, run);
  const reportRunId = await ctx.db.insert("runs", {
    threadId,
    botId: run.botId,
    ownerId: run.ownerId,
    trigger: "schedule",
    capability: "readOnly",
    state: { kind: "queued" },
    cancelRequested: false,
    nextSeq: 1,
  });
  await ctx.db.insert("runEvents", {
    runId: reportRunId,
    threadId,
    seq: 0,
    body: { kind: "routineReport", scheduleId, runId: run._id, text },
  });
  await endRun(ctx, reportRunId, { kind: "done" });
}

function endedByThisClaim(run: Doc<"runs">) {
  return { kind: "ended" as const, generation: run.computerGeneration ?? 0, ownerId: run.ownerId, botId: run.botId, capability: run.capability };
}

type AppendBody = Infer<typeof appendBody>;

async function storedBodyOf(ctx: MutationCtx, run: Doc<"runs">, body: AppendBody): Promise<RunEventBody> {
  switch (body.kind) {
    case "memorySave":
    case "memoryForget":
    case "descriptionSet":
      return await applyMemoryCall(ctx, run, body);
    case "scheduleCreate":
    case "scheduleUpdate":
    case "scheduleDelete":
      return await applyScheduleCall(ctx, run, body);
    case "toolResult": {
      if (!("screen" in body)) {
        return body;
      }
      const { screen, ...stored } = body;
      await keepScreen(ctx, run, body.toolCallId, screen);
      return stored;
    }
    default:
      return body;
  }
}

export const listQueued = query({
  args: { ownerId: v.optional(v.id("users")) },
  handler: async (ctx, { ownerId }) => {
    await requireService(ctx);
    const queued = await ctx.db
      .query("runs")
      .withIndex("by_state", (q) => q.eq("state.kind", "queued"))
      .filter((q) => (ownerId === undefined ? true : q.eq(q.field("ownerId"), ownerId)))
      .take(CLAIMABLE_PAGE);
    return queued.map((run) => run._id);
  },
});

// `now` is the caller's, because a query result is cached. claim checks the lease again with its own clock.
export const listClaimable = query({
  args: { now: v.number(), ownerId: v.optional(v.id("users")) },
  handler: async (ctx, { now, ownerId }) => {
    await requireService(ctx);
    const running = await ctx.db
      .query("runs")
      .withIndex("by_state", (q) => q.eq("state.kind", "running"))
      .filter((q) => (ownerId === undefined ? true : q.eq(q.field("ownerId"), ownerId)))
      .collect();
    const queued = await ctx.db
      .query("runs")
      .withIndex("by_state", (q) => q.eq("state.kind", "queued"))
      .filter((q) => (ownerId === undefined ? true : q.eq(q.field("ownerId"), ownerId)))
      .take(CLAIMABLE_PAGE);
    const expired = running.filter((run) => run.state.kind === "running" && run.state.leaseUntil < now);
    return [...queued, ...expired].map((run) => run._id);
  },
});

export const claim = mutation({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }) => {
    await requireService(ctx);
    const now = Date.now();
    const run = await ctx.db.get(runId);
    if (run === null || !noRunnerHolds(run, now)) {
      return { kind: "unavailable" as const };
    }
    // The runner polls, so this run starts when the fence ends. It comes before the count below, because no attempt happened.
    const computer = await ctx.db
      .query("computers")
      .withIndex("by_owner", (q) => q.eq("ownerId", run.ownerId))
      .unique();
    if (computer?.reset !== undefined || computer?.desiredVm?.removing === true || (computer?.updateFenceUntil ?? 0) > now) {
      return { kind: "unavailable" as const };
    }
    if (pastDeadline(run, now)) {
      await endPastDeadline(ctx, run);
      return endedByThisClaim(run);
    }
    // Every attempt passes through here, and a crash cannot lose this count. Each attempt may have paid for a model call.
    const claimsWithoutProgress = run.nextSeq === run.lastClaimSeq ? (run.claimsWithoutProgress ?? 0) + 1 : 0;
    if (claimsWithoutProgress >= MAX_CLAIMS_WITHOUT_PROGRESS) {
      await closeUnansweredCalls(ctx, run);
      await endRun(ctx, runId, run.cancelRequested ? { kind: "cancelled" } : { kind: "failed", reason: noProgressReason(run) });
      return endedByThisClaim(run);
    }
    const leaseToken = crypto.randomUUID();
    await ctx.db.patch(runId, {
      state: { kind: "running", leaseToken, leaseUntil: now + LEASE_MS },
      computerGeneration: run.computerGeneration ?? computer?.desiredVm?.generation ?? 0,
      lastClaimSeq: run.nextSeq,
      claimsWithoutProgress,
    });
    return {
      kind: "claimed" as const,
      generation: run.computerGeneration ?? computer?.desiredVm?.generation ?? 0,
      leaseToken,
      threadId: run.threadId,
      botId: run.botId,
      ownerId: run.ownerId,
      capability: run.capability,
      cancelRequested: run.cancelRequested,
      nextSeq: run.nextSeq,
    };
  },
});

export const heartbeat = mutation({
  args: fence,
  handler: async (ctx, { runId, leaseToken }) => {
    await requireService(ctx);
    const run = await ctx.db.get(runId);
    if (run === null || run.state.kind !== "running" || run.state.leaseToken !== leaseToken) {
      return { kind: "lost" as const };
    }
    if ((await computerOfOwner(ctx, run.ownerId))?.reset !== undefined) return { kind: "lost" as const };
    const now = Date.now();
    await ctx.db.patch(runId, { state: { ...run.state, leaseUntil: now + LEASE_MS } });
    return { kind: "renewed" as const, cancelRequested: run.cancelRequested || pastDeadline(run, now) };
  },
});

export const append = mutation({
  args: { ...fence, expectedSeq: v.number(), body: appendBody },
  handler: async (ctx, { runId, leaseToken, expectedSeq, body }) => {
    await requireService(ctx);
    const run = await requireLease(ctx, { runId, leaseToken });
    if (run.nextSeq !== expectedSeq) {
      throw new ConvexError(`Expected seq ${run.nextSeq}, got ${expectedSeq}`);
    }
    const stored = await storedBodyOf(ctx, run, body);
    await ctx.db.insert("runEvents", { runId, threadId: run.threadId, seq: expectedSeq, body: stored });
    await ctx.db.patch(runId, { nextSeq: expectedSeq + 1 });
    await deleteStream(ctx, runId);
    return stored;
  },
});

export const patchStream = mutation({
  args: { ...fence, text: v.string(), reasoning: v.optional(v.string()) },
  handler: async (ctx, { runId, leaseToken, text, reasoning }) => {
    await requireService(ctx);
    await requireLease(ctx, { runId, leaseToken });
    const stream = await ctx.db
      .query("runStreams")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .unique();
    if (stream === null) {
      await ctx.db.insert("runStreams", { runId, text, reasoning });
    } else {
      await ctx.db.replace(stream._id, { runId, text, reasoning });
    }
  },
});

export const finish = mutation({
  args: { ...fence, state: terminalRunState },
  handler: async (ctx, { runId, leaseToken, state }) => {
    await requireService(ctx);
    const run = await requireLease(ctx, { runId, leaseToken });
    const ended = finishedState({ run, state, now: Date.now() });
    if (ended.kind !== "done" || run.scheduleId === undefined) {
      await endRun(ctx, runId, ended);
      return;
    }
    const report = await lastTurnTextOf(ctx, runId);
    if (report === null) {
      await endRun(ctx, runId, { kind: "failed", reason: NO_REPORT_REASON });
      return;
    }
    await postReport(ctx, run, run.scheduleId, report);
    await endRun(ctx, runId, ended);
  },
});

export const earlierReports = query({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }) => {
    await requireService(ctx);
    const scheduleId = (await ctx.db.get(runId))?.scheduleId;
    if (scheduleId === undefined) {
      return [];
    }
    const runs = await ctx.db
      .query("runs")
      .withIndex("by_schedule", (q) => q.eq("scheduleId", scheduleId))
      .order("desc")
      .filter((q) => q.eq(q.field("state.kind"), "done"))
      .take(EARLIER_REPORTS);
    const reports = [];
    for (const run of runs.toReversed()) {
      const text = await lastTurnTextOf(ctx, run._id);
      if (text !== null) {
        reports.push({ date: new Date(run._creationTime).toISOString(), text });
      }
    }
    return reports;
  },
});

export const eventsPage = query({
  args: { runId: v.id("runs"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { runId, paginationOpts }) => {
    await requireService(ctx);
    return await ctx.db
      .query("runEvents")
      .withIndex("by_run_seq", (q) => q.eq("runId", runId))
      .paginate(paginationOpts);
  },
});

export const requestCancel = mutation({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }) => {
    const { user } = await requireIdentity(ctx);
    const run = await ctx.db.get(runId);
    if (user === null || run === null || run.ownerId !== user._id) {
      throw new ConvexError("Run not found");
    }
    switch (run.state.kind) {
      // No runner holds a queued run, so nothing else would ever act on the request.
      case "queued":
        await ctx.db.patch(runId, { cancelRequested: true });
        await endRun(ctx, runId, { kind: "cancelled" });
        return;
      case "running":
        await ctx.db.patch(runId, { cancelRequested: true });
        return;
      case "done":
      case "failed":
      case "cancelled":
        return;
    }
  },
});
