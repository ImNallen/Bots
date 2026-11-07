import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel.js";
import { internalMutation, type MutationCtx } from "./_generated/server.js";

const RUN_LIMIT_MS = 30 * 60 * 1000;

// The one way to make a read-only run. No public function reaches it, so neither a user's token nor the service's can.
export async function startReadOnlyRun(ctx: MutationCtx, schedule: Doc<"schedules">, deadlineAt: number): Promise<Id<"runs">> {
  const { threadId, botId, ownerId } = schedule;
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

// These two exist for `scripts/verify-agent.ts`, which calls them with the admin key. Nothing in production calls them.
export const createForCheck = internalMutation({
  args: { botId: v.id("bots"), instruction: v.string() },
  handler: async (ctx, { botId, instruction }) => {
    const bot = await ctx.db.get(botId);
    if (bot === null) {
      throw new ConvexError("Bot not found");
    }
    const threadId = await ctx.db.insert("threads", { botId, ownerId: bot.ownerId, kind: "routine" });
    const scheduleId = await ctx.db.insert("schedules", { ownerId: bot.ownerId, botId, threadId, instruction });
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
    return await startReadOnlyRun(ctx, schedule, deadlineAt ?? Date.now() + RUN_LIMIT_MS);
  },
});
