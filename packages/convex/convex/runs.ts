import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel.js";
import { mutation, query, type MutationCtx } from "./_generated/server.js";
import { requireIdentity, requireService } from "./identity.js";
import { runEventBody, terminalRunState } from "./validators.js";

const LEASE_MS = 15_000;
const CLAIMABLE_PAGE = 64;

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
    const leaseToken = crypto.randomUUID();
    await ctx.db.patch(runId, { state: { kind: "running", leaseToken, leaseUntil: now + LEASE_MS } });
    const bot = await ctx.db.get(run.botId);
    return {
      kind: "claimed" as const,
      leaseToken,
      threadId: run.threadId,
      botId: run.botId,
      botName: bot?.name ?? "Bot",
      ownerId: run.ownerId,
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
    await ctx.db.patch(runId, { state: { ...run.state, leaseUntil: Date.now() + LEASE_MS } });
    return { kind: "renewed" as const, cancelRequested: run.cancelRequested };
  },
});

export const append = mutation({
  args: { ...fence, expectedSeq: v.number(), body: runEventBody },
  handler: async (ctx, { runId, leaseToken, expectedSeq, body }) => {
    await requireService(ctx);
    const run = await requireLease(ctx, { runId, leaseToken });
    if (run.nextSeq !== expectedSeq) {
      throw new ConvexError(`Expected seq ${run.nextSeq}, got ${expectedSeq}`);
    }
    await ctx.db.insert("runEvents", { runId, threadId: run.threadId, seq: expectedSeq, body });
    await ctx.db.patch(runId, { nextSeq: expectedSeq + 1 });
    await deleteStream(ctx, runId);
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
    await requireLease(ctx, { runId, leaseToken });
    await ctx.db.patch(runId, { state });
    await deleteStream(ctx, runId);
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
        await ctx.db.patch(runId, { state: { kind: "cancelled" }, cancelRequested: true });
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
