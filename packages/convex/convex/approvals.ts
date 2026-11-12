import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel.js";
import { mutation, query, type QueryCtx } from "./_generated/server.js";
import { requireIdentity, requireService } from "./identity.js";
import { computerOfOwner, requireComputerAvailable } from "./computers.js";
import { screenBox } from "./validators.js";

// Long enough for a person who is asleep. After this the bot gets a refusal and can tell the user what it wanted.
const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

// A restarted runner asks again with the same call, and it must find the same row and the same answer.
export const request = mutation({
  args: { runId: v.id("runs"), toolCallId: v.string(), toolName: v.string(), subject: v.optional(v.string()), box: v.optional(screenBox), reason: v.optional(v.string()) },
  handler: async (ctx, { runId, toolCallId, toolName, subject, box, reason }) => {
    await requireService(ctx);
    const run = await ctx.db.get(runId);
    if (run === null || (run.state.kind !== "queued" && run.state.kind !== "running")) {
      throw new ConvexError("No such run");
    }
    await requireComputerAvailable(ctx, run.ownerId);
    if (run.capability !== "full") {
      throw new ConvexError("A read-only run cannot ask for approval");
    }
    const existing = await ctx.db
      .query("approvals")
      .withIndex("by_run_call", (q) => q.eq("runId", runId).eq("toolCallId", toolCallId))
      .unique();
    if (existing !== null) {
      return { approvalId: existing._id, state: existing.state, expiresAt: existing.requestedAt + APPROVAL_TTL_MS };
    }
    const requestedAt = Date.now();
    const approvalId = await ctx.db.insert("approvals", {
      ownerId: run.ownerId,
      botId: run.botId,
      threadId: run.threadId,
      runId,
      toolCallId,
      toolName,
      state: "pending",
      requestedAt,
      ...(subject === undefined ? {} : { subject }),
      ...(box === undefined ? {} : { box }),
      ...(reason === undefined ? {} : { reason }),
    });
    return { approvalId, state: "pending" as const, expiresAt: requestedAt + APPROVAL_TTL_MS };
  },
});

export const stateOf = query({
  args: { approvalId: v.id("approvals") },
  handler: async (ctx, { approvalId }) => {
    await requireService(ctx);
    // A request that has vanished cannot have been approved.
    const approval = await ctx.db.get(approvalId);
    if (approval === null) return "denied";
    if ((await computerOfOwner(ctx, approval.ownerId))?.reset !== undefined) return "expired";
    return approval.state;
  },
});

export const decide = mutation({
  args: { approvalId: v.id("approvals"), decision: v.union(v.literal("approved"), v.literal("denied")) },
  handler: async (ctx, { approvalId, decision }) => {
    const { user } = await requireIdentity(ctx);
    const approval = await ctx.db.get(approvalId);
    if (user === null || approval === null || approval.ownerId !== user._id) {
      throw new ConvexError("Approval not found");
    }
    await requireComputerAvailable(ctx, approval.ownerId);
    // The first answer stands, so a second device cannot turn a refusal into a run.
    if (approval.state !== "pending") {
      throw new ConvexError("This call has already been answered");
    }
    await ctx.db.patch(approvalId, { state: decision });
  },
});

export const expire = mutation({
  args: { approvalId: v.id("approvals") },
  handler: async (ctx, { approvalId }) => {
    await requireService(ctx);
    const approval = await ctx.db.get(approvalId);
    if (approval?.state === "pending") {
      await ctx.db.patch(approvalId, { state: "expired" });
    }
  },
});

async function pendingOnActiveRuns<T extends { runId: Id<"runs"> }>(ctx: QueryCtx, approvals: T[]): Promise<T[]> {
  const live: T[] = [];
  for (const approval of approvals) {
    const run = await ctx.db.get(approval.runId);
    if (run?.state.kind === "running" || run?.state.kind === "queued") {
      live.push(approval);
    }
  }
  return live;
}

export const pendingForThread = query({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    const { user } = await requireIdentity(ctx);
    const thread = await ctx.db.get(threadId);
    if (user === null || thread === null) {
      return [];
    }
    const rows = await ctx.db
      .query("approvals")
      .withIndex("by_thread_state", (q) => q.eq("threadId", threadId).eq("state", "pending"))
      .collect();
    const mine = rows.filter((row) => row.ownerId === user._id);
    return (await pendingOnActiveRuns(ctx, mine)).map(({ _id, runId, toolCallId, subject, reason }) => ({ _id, runId, toolCallId, subject: subject ?? null, reason: reason ?? null }));
  },
});

export const pendingBots = query({
  args: {},
  handler: async (ctx) => {
    const { user } = await requireIdentity(ctx);
    if (user === null) {
      return [];
    }
    const rows = await ctx.db
      .query("approvals")
      .withIndex("by_owner_state", (q) => q.eq("ownerId", user._id).eq("state", "pending"))
      .collect();
    return [...new Set((await pendingOnActiveRuns(ctx, rows)).map((row) => row.botId))];
  },
});
