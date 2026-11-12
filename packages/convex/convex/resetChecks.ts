import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server.js";

export const seed = internalMutation({
  args: { computerId: v.id("computers"), botId: v.id("bots"), count: v.number() },
  handler: async (ctx, { computerId, botId, count }) => {
    const computer = await ctx.db.get(computerId);
    const bot = await ctx.db.get(botId);
    if (computer === null || bot?.ownerId !== computer.ownerId || count > 200) throw new Error("Invalid reset fixture");
    const routines = [];
    for (let index = 0; index < count; index++) {
      await ctx.db.insert("bots", { ownerId: bot.ownerId, name: "Reset batch check", color: bot.color, shape: bot.shape, takeoverUntil: Date.now() + 60000 });
      const threadId = await ctx.db.insert("threads", { botId, ownerId: bot.ownerId, kind: "routine" });
      const runId = await ctx.db.insert("runs", { botId, threadId, ownerId: bot.ownerId, trigger: "user", capability: "full", state: { kind: "queued" }, cancelRequested: false, nextSeq: 0 });
      await ctx.db.insert("approvals", { botId, threadId, runId, ownerId: bot.ownerId, toolCallId: `batch-${index}`, toolName: "shell", state: "pending", requestedAt: Date.now() });
      routines.push(await ctx.db.insert("schedules", { botId, threadId, ownerId: bot.ownerId, instruction: "Batch check", cadence: { kind: "everyHours", hours: 24 } }));
    }
    return routines;
  },
});

export const inspect = internalQuery({
  args: { computerId: v.id("computers") },
  handler: async (ctx, { computerId }) => {
    const computer = await ctx.db.get(computerId);
    if (computer === null) throw new Error("Missing fixture");
    const runs = await ctx.db.query("runs").withIndex("by_owner", (q) => q.eq("ownerId", computer.ownerId)).collect();
    const approvals = await ctx.db.query("approvals").withIndex("by_owner_state", (q) => q.eq("ownerId", computer.ownerId).eq("state", "pending")).collect();
    const bots = await ctx.db.query("bots").withIndex("by_owner", (q) => q.eq("ownerId", computer.ownerId)).collect();
    return { cleanup: computer.resetCleanup, cancelled: runs.filter((run) => run.state.kind === "cancelled").length, active: runs.filter((run) => run.state.kind === "queued" || run.state.kind === "running").length, pending: approvals.length, takeovers: bots.filter((bot) => bot.takeoverUntil !== undefined).length };
  },
});

export const makeDue = internalMutation({
  args: { scheduleIds: v.array(v.id("schedules")) },
  handler: async (ctx, { scheduleIds }) => {
    if (scheduleIds.length > 200) throw new Error("Too many fixture routines");
    for (const scheduleId of scheduleIds) await ctx.db.patch(scheduleId, { nextFireAt: Date.now() - 1000 });
  },
});
