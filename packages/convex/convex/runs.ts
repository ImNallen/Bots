import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel.js";
import { mutation, query, type MutationCtx } from "./_generated/server.js";
import { requireIdentity, requireService } from "./identity.js";
import { applyMemoryCall } from "./memories.js";
import { memoryCall, runEventBody, terminalRunState, type TerminalRunState } from "./validators.js";

const LEASE_MS = 15_000;
const CLAIMABLE_PAGE = 64;
const MAX_CLAIMS_WITHOUT_PROGRESS = 5;
const NO_PROGRESS_REASON = `The run stopped after ${MAX_CLAIMS_WITHOUT_PROGRESS} attempts in a row failed with no progress. Send another message to try again.`;
const DEADLINE_REASON = "The routine ran past its 30 minute limit";

const UNANSWERED_CALL_OUTPUT =
  "The run stopped before this call reported a result, so the outcome is unknown. It may have run, and it may still be running.";

const fence = { runId: v.id("runs"), leaseToken: v.string() };

async function requireLease(
  ctx: MutationCtx,
  args: { runId: Id<"runs">; leaseToken: string },
): Promise<Doc<"runs">> {
  const run = await ctx.db.get(args.runId);
  if (run === null || run.state.kind !== "running" || run.state.leaseToken !== args.leaseToken) {
    throw new ConvexError("Lease lost");
  }
  return run;
}

async function deleteStream(ctx: MutationCtx, runId: Id<"runs">): Promise<void> {
  const stream = await ctx.db
    .query("runStreams")
    .withIndex("by_run", (q) => q.eq("runId", runId))
    .unique();
  if (stream !== null) {
    await ctx.db.delete(stream._id);
  }
}

function pastDeadline(run: Pick<Doc<"runs">, "deadlineAt">, now: number): boolean {
  return run.deadlineAt !== undefined && now > run.deadlineAt;
}

// The one writer of a terminal state and an end time, so no run can end without one.
async function endRun(ctx: MutationCtx, run: Doc<"runs">, state: TerminalRunState): Promise<void> {
  await ctx.db.patch(run._id, { state, endedAt: Date.now() });
  await deleteStream(ctx, run._id);
}

// run.cancelRequested means only that the owner pressed Stop, so a stop without it came from the deadline.
export function finishedState(args: { run: Pick<Doc<"runs">, "cancelRequested" | "deadlineAt">; state: TerminalRunState; now: number }): TerminalRunState {
  const { run, state, now } = args;
  return state.kind === "cancelled" && !run.cancelRequested && pastDeadline(run, now) ? { kind: "failed", reason: DEADLINE_REASON } : state;
}

// Every later model request replays this history, and a tool call with no result would make it malformed.
async function closeUnansweredCalls(ctx: MutationCtx, run: Doc<"runs">): Promise<void> {
  const answered = new Set<string>();
  for await (const event of ctx.db
    .query("runEvents")
    .withIndex("by_run_seq", (q) => q.eq("runId", run._id))
    .order("desc")) {
    if (event.body.kind === "toolResult") {
      answered.add(event.body.toolCallId);
      continue;
    }
    if (event.body.kind !== "assistantTurn") {
      return;
    }
    let seq = run.nextSeq;
    for (const call of event.body.toolCalls.filter(({ id }) => !answered.has(id))) {
      await ctx.db.insert("runEvents", {
        runId: run._id,
        threadId: run.threadId,
        seq,
        body: {
          kind: "toolResult",
          toolCallId: call.id,
          name: call.name,
          outcome: "unavailable",
          output: UNANSWERED_CALL_OUTPUT,
          truncated: false,
        },
      });
      seq += 1;
    }
    await ctx.db.patch(run._id, { nextSeq: seq });
    return;
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
    const claimable =
      run !== null &&
      (run.state.kind === "queued" || (run.state.kind === "running" && run.state.leaseUntil < now));
    if (!claimable) {
      return { kind: "unavailable" as const };
    }
    if (pastDeadline(run, now)) {
      await closeUnansweredCalls(ctx, run);
      await endRun(ctx, run, run.cancelRequested ? { kind: "cancelled" } : { kind: "failed", reason: DEADLINE_REASON });
      return { kind: "unavailable" as const };
    }
    // The runner polls, so this run starts when the fence ends. It comes before the count below, because no attempt happened.
    const computer = await ctx.db
      .query("computers")
      .withIndex("by_owner", (q) => q.eq("ownerId", run.ownerId))
      .unique();
    if ((computer?.updateFenceUntil ?? 0) > now) {
      return { kind: "unavailable" as const };
    }
    // Every attempt passes through here, and a crash cannot lose this count. Each attempt may have paid for a model call.
    const claimsWithoutProgress = run.nextSeq === run.lastClaimSeq ? (run.claimsWithoutProgress ?? 0) + 1 : 0;
    if (claimsWithoutProgress >= MAX_CLAIMS_WITHOUT_PROGRESS) {
      await closeUnansweredCalls(ctx, run);
      await endRun(ctx, run, run.cancelRequested ? { kind: "cancelled" } : { kind: "failed", reason: NO_PROGRESS_REASON });
      return { kind: "unavailable" as const };
    }
    const leaseToken = crypto.randomUUID();
    await ctx.db.patch(runId, {
      state: { kind: "running", leaseToken, leaseUntil: now + LEASE_MS },
      lastClaimSeq: run.nextSeq,
      claimsWithoutProgress,
    });
    return {
      kind: "claimed" as const,
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
    const now = Date.now();
    await ctx.db.patch(runId, { state: { ...run.state, leaseUntil: now + LEASE_MS } });
    // Not stored, so run.cancelRequested still says only that the owner pressed Stop.
    return { kind: "renewed" as const, cancelRequested: run.cancelRequested || pastDeadline(run, now) };
  },
});

export const append = mutation({
  args: { ...fence, expectedSeq: v.number(), body: v.union(runEventBody, memoryCall) },
  handler: async (ctx, { runId, leaseToken, expectedSeq, body }) => {
    await requireService(ctx);
    const run = await requireLease(ctx, { runId, leaseToken });
    if (run.nextSeq !== expectedSeq) {
      throw new ConvexError(`Expected seq ${run.nextSeq}, got ${expectedSeq}`);
    }
    const stored = body.kind === "memorySave" || body.kind === "memoryForget" ? await applyMemoryCall(ctx, run, body) : body;
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
    await endRun(ctx, run, finishedState({ run, state, now: Date.now() }));
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
        await endRun(ctx, run, { kind: "cancelled" });
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
