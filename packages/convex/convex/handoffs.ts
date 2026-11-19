import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server.js";
import { handoffView, requireHandoffContext } from "./handoffChecks.js";
import { requireIdentity, requireService } from "./identity.js";
import { deletePage } from "./pages.js";
import { endRun } from "./runEnd.js";
import { deleteScreen } from "./screens.js";

const identity = { runId: v.id("runs"), toolCallId: v.string() };

export const request = mutation({
  args: { ...identity, leaseToken: v.string() },
  handler: async (ctx, { runId, toolCallId, leaseToken }) => {
    await requireService(ctx);
    const run = await ctx.db.get(runId);
    if (run?.state.kind !== "running" || run.state.leaseToken !== leaseToken || run.state.leaseUntil <= Date.now()) throw new ConvexError("Lease lost");
    const view = await handoffView(ctx, run, toolCallId);
    if (view.kind === "completed" || view.kind === "declined") return view;
    const context = await requireHandoffContext(ctx, run, toolCallId);
    if (run.handoff !== undefined) {
      if (run.handoff.toolCallId !== toolCallId) throw new ConvexError("Another help request is current");
      return view;
    }
    const requestedAt = Date.now();
    await ctx.db.patch(runId, { handoff: { toolCallId, requestedAt, state: { kind: "pending" } } });
    return { kind: "pending" as const, reason: context.reason, requestedAt };
  },
});

export const stateOf = query({
  args: identity,
  handler: async (ctx, { runId, toolCallId }) => {
    await requireService(ctx);
    return await handoffView(ctx, await ctx.db.get(runId), toolCallId);
  },
});

export const decide = mutation({
  args: { ...identity, decision: v.union(v.object({ kind: v.literal("complete"), controlSessionId: v.optional(v.string()) }), v.object({ kind: v.literal("decline") })) },
  handler: async (ctx, { runId, toolCallId, decision }) => {
    const { user } = await requireIdentity(ctx);
    const run = await ctx.db.get(runId);
    if (user === null || run === null || run.ownerId !== user._id) throw new ConvexError("Help request not found");
    const view = await handoffView(ctx, run, toolCallId);
    if (view.kind !== "pending") return view;
    const { bot } = await requireHandoffContext(ctx, run, toolCallId);
    if (decision.kind === "decline") {
      await endRun(ctx, runId, { kind: "cancelled" }, "declined");
      return { kind: "declined" as const };
    }
    const live = (bot.takeoverUntil ?? 0) > Date.now();
    if (decision.controlSessionId !== undefined ? !live || bot.takeoverSessionId !== decision.controlSessionId : live) throw new ConvexError("Another control session is active or this session ended. Reopen the screen or use Resume bot after giving back control.");
    if (run.handoff === undefined) throw new ConvexError("Help request not found");
    const completedAt = Date.now();
    await ctx.db.patch(runId, { handoff: { ...run.handoff, state: { kind: "completed", completedAt } } });
    await ctx.db.patch(bot._id, { takeoverUntil: undefined, takeoverSessionId: undefined });
    await deletePage(ctx, runId);
    await deleteScreen(ctx, runId);
    return { kind: "completed" as const, completedAt };
  },
});
