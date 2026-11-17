import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server.js";
import { purgeRunBatch } from "./threads.js";

export const routine = internalMutation({
  args: { botId: v.id("bots") },
  handler: async (ctx, { botId }) => {
    const bot = await ctx.db.get(botId);
    if (bot === null) throw new Error("Missing fixture bot");
    const threadId = await ctx.db.insert("threads", { ownerId: bot.ownerId, botId, kind: "routine" });
    return await ctx.db.insert("runs", { ownerId: bot.ownerId, botId, threadId, trigger: "schedule", capability: "readOnly", state: { kind: "queued" }, cancelRequested: false, nextSeq: 0 });
  },
});

export const inspect = internalQuery({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }) => ({
    run: await ctx.db.get(runId),
    pages: await ctx.db.query("pages").withIndex("by_run", (q) => q.eq("runId", runId)).collect(),
  }),
});

export const purge = internalMutation({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }) => await purgeRunBatch(ctx, runId),
});

export const expireLease = internalMutation({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }) => {
    const run = await ctx.db.get(runId);
    if (run?.state.kind !== "running") throw new Error("Fixture has no lease");
    await ctx.db.patch(runId, { state: { ...run.state, leaseUntil: 0 } });
  },
});
