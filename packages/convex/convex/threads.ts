import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel.js";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { requireIdentity, requireService } from "./identity.js";
import type { RunState } from "./validators.js";

const MAX_MESSAGE_LENGTH = 64 * 1024;
const TIMELINE_USER_RUNS = 30;
const TIMELINE_MAX_RUNS = 200;
// A query may read 16 MiB. One event is at most 1 MiB, so stopping here cannot overshoot the limit.
const TIMELINE_BYTES = 8 * 1024 * 1024;
// One event is at most 1 MiB, so a batch stays well under what a mutation may read.
const PURGE_BATCH = 8;
const encoder = new TextEncoder();

async function requireOwnedThread(ctx: QueryCtx, threadId: Id<"threads">): Promise<Doc<"threads">> {
  const { user } = await requireIdentity(ctx);
  const thread = await ctx.db.get(threadId);
  if (user === null || thread === null || thread.ownerId !== user._id) {
    throw new ConvexError("Thread not found");
  }
  return thread;
}

export function isActive(state: RunState): boolean {
  return state.kind === "queued" || state.kind === "running";
}

export async function chatThreadOf(ctx: QueryCtx, botId: Id<"bots">): Promise<Doc<"threads"> | null> {
  return await ctx.db
    .query("threads")
    .withIndex("by_bot", (q) => q.eq("botId", botId).eq("kind", undefined))
    .first();
}

export async function ensureChatThread(ctx: MutationCtx, bot: { botId: Id<"bots">; ownerId: Id<"users"> }): Promise<Id<"threads">> {
  return (await chatThreadOf(ctx, bot.botId))?._id ?? (await ctx.db.insert("threads", { botId: bot.botId, ownerId: bot.ownerId }));
}

export async function activeRunOfBot(ctx: QueryCtx, botId: Id<"bots">): Promise<Doc<"runs"> | null> {
  for (const kind of ["running", "queued"] as const) {
    const run = await ctx.db
      .query("runs")
      .withIndex("by_bot_state", (q) => q.eq("botId", botId).eq("state.kind", kind))
      .first();
    if (run !== null) {
      return run;
    }
  }
  return null;
}

export const activeRun = query({
  args: { botId: v.id("bots") },
  handler: async (ctx, { botId }) => {
    const { user } = await requireIdentity(ctx);
    const bot = await ctx.db.get(botId);
    if (user === null || bot === null || bot.ownerId !== user._id) {
      return null;
    }
    const run = await activeRunOfBot(ctx, botId);
    return run === null ? null : { _id: run._id, routine: run.scheduleId !== undefined, cancelRequested: run.cancelRequested };
  },
});

export async function purgeRunBatch(ctx: MutationCtx, runId: Id<"runs">): Promise<void> {
  const details = [
    ...(await ctx.db
      .query("runEvents")
      .withIndex("by_run_seq", (q) => q.eq("runId", runId))
      .take(PURGE_BATCH)),
    ...(await ctx.db
      .query("runStreams")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .take(PURGE_BATCH)),
  ];
  await Promise.all(details.length > 0 ? details.map((document) => ctx.db.delete(document._id)) : [ctx.db.delete(runId)]);
}

// A thread goes last, so a thread that is gone means its whole history is. Each call deletes one batch, and its caller schedules the next.
export async function purgeThreadBatch(ctx: MutationCtx, threadId: Id<"threads">): Promise<void> {
  const run = await ctx.db
    .query("runs")
    .withIndex("by_thread", (q) => q.eq("threadId", threadId))
    .first();
  if (run !== null) {
    await purgeRunBatch(ctx, run._id);
    return;
  }
  const approvals = await ctx.db
    .query("approvals")
    .withIndex("by_thread_state", (q) => q.eq("threadId", threadId))
    .take(PURGE_BATCH);
  await Promise.all(approvals.length > 0 ? approvals.map((approval) => ctx.db.delete(approval._id)) : [ctx.db.delete(threadId)]);
}

export const ensureForBot = mutation({
  args: { botId: v.id("bots") },
  handler: async (ctx, { botId }) => {
    const { user } = await requireIdentity(ctx);
    const bot = await ctx.db.get(botId);
    if (user === null || bot === null || bot.ownerId !== user._id) {
      throw new ConvexError("Bot not found");
    }
    return await ensureChatThread(ctx, { botId, ownerId: user._id });
  },
});

export const send = mutation({
  args: { threadId: v.id("threads"), text: v.string() },
  handler: async (ctx, { threadId, text }) => {
    const thread = await requireOwnedThread(ctx, threadId);
    // A deleted bot's thread lasts until its purge ends, and a run started there would bring back the bot's files.
    if ((await ctx.db.get(thread.botId)) === null) {
      throw new ConvexError("Bot not found");
    }
    if (thread.kind === "routine") {
      throw new ConvexError("A routine's thread takes no messages");
    }
    const trimmed = text.trim();
    if (trimmed === "") {
      throw new ConvexError("Message cannot be empty");
    }
    if (trimmed.length > MAX_MESSAGE_LENGTH) {
      throw new ConvexError(`Message cannot be longer than ${MAX_MESSAGE_LENGTH} characters`);
    }
    if ((await activeRunOfBot(ctx, thread.botId)) !== null) {
      throw new ConvexError("This bot already has an active run");
    }
    const runId = await ctx.db.insert("runs", {
      threadId,
      botId: thread.botId,
      ownerId: thread.ownerId,
      trigger: "user",
      capability: "full",
      state: { kind: "queued" },
      cancelRequested: false,
      nextSeq: 1,
    });
    await ctx.db.insert("runEvents", {
      runId,
      threadId,
      seq: 0,
      body: { kind: "userMessage", text: trimmed },
    });
    return runId;
  },
});

export function runsToShow<T extends { trigger: Doc<"runs">["trigger"] }>(newestFirst: readonly T[]): T[] {
  const shown: T[] = [];
  let userRuns = 0;
  for (const run of newestFirst.slice(0, TIMELINE_MAX_RUNS)) {
    if (run.trigger === "user") {
      if (userRuns === TIMELINE_USER_RUNS) {
        break;
      }
      userRuns += 1;
    }
    shown.push(run);
  }
  return shown;
}

export function publicState(state: RunState) {
  switch (state.kind) {
    case "running":
      return { kind: "running" as const };
    case "queued":
    case "done":
    case "failed":
    case "cancelled":
      return state;
  }
}

export const timeline = query({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    await requireOwnedThread(ctx, threadId);
    const recentRuns = await ctx.db
      .query("runs")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .order("desc")
      .take(TIMELINE_MAX_RUNS + 1);
    const shownRuns = runsToShow(recentRuns);
    const runs = [];
    let bytes = 0;
    let omittedOlder = recentRuns.length > shownRuns.length;
    for (const run of shownRuns) {
      const events = [];
      for await (const event of ctx.db
        .query("runEvents")
        .withIndex("by_run_seq", (q) => q.eq("runId", run._id))
        .order("desc")) {
        bytes += encoder.encode(JSON.stringify(event)).length;
        if (bytes > TIMELINE_BYTES) {
          omittedOlder = true;
          break;
        }
        events.push({ _id: event._id, seq: event.seq, body: event.body });
      }
      const stream = isActive(run.state)
        ? await ctx.db
            .query("runStreams")
            .withIndex("by_run", (q) => q.eq("runId", run._id))
            .unique()
        : null;
      runs.push({
        _id: run._id,
        createdAt: run._creationTime,
        state: publicState(run.state),
        cancelRequested: run.cancelRequested,
        events: events.reverse(),
        stream: stream === null ? null : { text: stream.text, reasoning: stream.reasoning },
      });
      if (bytes > TIMELINE_BYTES) {
        break;
      }
    }
    return { runs: runs.reverse(), omittedOlder };
  },
});

export const eventsPage = query({
  args: { threadId: v.id("threads"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { threadId, paginationOpts }) => {
    await requireService(ctx);
    return await ctx.db
      .query("runEvents")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .paginate(paginationOpts);
  },
});
