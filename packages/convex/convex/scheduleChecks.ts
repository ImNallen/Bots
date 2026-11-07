import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server.js";
import { startReadOnlyRun } from "./schedules.js";
import { runState } from "./validators.js";

export const createForCheck = internalMutation({
  args: { botId: v.id("bots"), instruction: v.string() },
  handler: async (ctx, { botId, instruction }) => {
    const bot = await ctx.db.get(botId);
    if (bot === null) {
      throw new ConvexError("Bot not found");
    }
    const threadId = await ctx.db.insert("threads", { botId, ownerId: bot.ownerId, kind: "routine" });
    const scheduleId = await ctx.db.insert("schedules", {
      ownerId: bot.ownerId,
      botId,
      threadId,
      instruction,
      cadence: { kind: "everyHours", hours: 24 },
    });
    return { scheduleId, threadId };
  },
});

export const fireForCheck = internalMutation({
  args: { scheduleId: v.id("schedules"), deadlineAt: v.optional(v.number()) },
  handler: async (ctx, { scheduleId, deadlineAt }) => {
    const schedule = await ctx.db.get(scheduleId);
    if (schedule === null) {
      throw new ConvexError("Schedule not found");
    }
    return await startReadOnlyRun(ctx, schedule, deadlineAt);
  },
});

export const moveForCheck = internalMutation({
  args: { scheduleId: v.id("schedules"), nextFireAt: v.number() },
  handler: async (ctx, { scheduleId, nextFireAt }) => {
    await ctx.db.patch(scheduleId, { nextFireAt });
  },
});

export const seedRunsForCheck = internalMutation({
  args: {
    scheduleId: v.id("schedules"),
    count: v.number(),
    state: runState,
    endedAt: v.optional(v.number()),
    deadlineAt: v.optional(v.number()),
    asReports: v.optional(v.boolean()),
  },
  handler: async (ctx, { scheduleId, count, state, endedAt, deadlineAt, asReports }) => {
    const schedule = await ctx.db.get(scheduleId);
    if (schedule === null) {
      throw new ConvexError("Schedule not found");
    }
    const { threadId, botId, ownerId, instruction } = schedule;
    const ids = [];
    for (let index = 0; index < count; index += 1) {
      const runId = await ctx.db.insert("runs", {
        threadId,
        botId,
        ownerId,
        trigger: "schedule",
        capability: "readOnly",
        ...(asReports === true ? {} : { scheduleId }),
        deadlineAt,
        endedAt,
        state,
        cancelRequested: false,
        nextSeq: 2,
      });
      await ctx.db.insert("runEvents", { runId, threadId, seq: 0, body: { kind: "scheduleFired", scheduleId, text: instruction } });
      await ctx.db.insert("runEvents", {
        runId,
        threadId,
        seq: 1,
        body: { kind: "assistantTurn", text: `seeded report ${index}`, toolCalls: [], usage: { promptTokens: 1, completionTokens: 1 }, model: "seeded" },
      });
      ids.push(runId);
    }
    return ids;
  },
});

export const routineForCheck = internalQuery({
  args: { scheduleId: v.id("schedules") },
  handler: async (ctx, { scheduleId }) => await ctx.db.get(scheduleId),
});

export const rowsOfThreadForCheck = internalQuery({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => ({
    thread: (await ctx.db.get(threadId)) !== null,
    runs: (await ctx.db.query("runs").withIndex("by_thread", (q) => q.eq("threadId", threadId)).collect()).length,
    events: (await ctx.db.query("runEvents").withIndex("by_thread", (q) => q.eq("threadId", threadId)).collect()).length,
  }),
});

export const routinesOfOwnerForCheck = internalQuery({
  args: { ownerId: v.id("users") },
  handler: async (ctx, { ownerId }) => await ctx.db.query("schedules").withIndex("by_owner", (q) => q.eq("ownerId", ownerId)).collect(),
});
