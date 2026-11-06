import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel.js";
import { mutation, query, type QueryCtx } from "./_generated/server.js";
import { requireIdentity, requireService } from "./identity.js";
import type { RunState } from "./validators.js";

const MAX_MESSAGE_LENGTH = 64 * 1024;
const TIMELINE_RUNS = 30;
// A query may read 16 MiB. One event is at most 1 MiB, so stopping here cannot overshoot the limit.
const TIMELINE_BYTES = 8 * 1024 * 1024;
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

export const ensureForBot = mutation({
  args: { botId: v.id("bots") },
  handler: async (ctx, { botId }) => {
    const { user } = await requireIdentity(ctx);
    const bot = await ctx.db.get(botId);
    if (user === null || bot === null || bot.ownerId !== user._id) {
      throw new ConvexError("Bot not found");
    }
    const existing = await ctx.db
      .query("threads")
      .withIndex("by_bot", (q) => q.eq("botId", botId))
      .first();
    return existing?._id ?? (await ctx.db.insert("threads", { botId, ownerId: user._id }));
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
    const trimmed = text.trim();
    if (trimmed === "") {
      throw new ConvexError("Message cannot be empty");
    }
    if (trimmed.length > MAX_MESSAGE_LENGTH) {
      throw new ConvexError(`Message cannot be longer than ${MAX_MESSAGE_LENGTH} characters`);
    }
    const latest = await ctx.db
      .query("runs")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .order("desc")
      .first();
    if (latest !== null && isActive(latest.state)) {
      throw new ConvexError("This thread already has an active run");
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

function publicState(state: RunState) {
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
      .take(TIMELINE_RUNS + 1);
    const runs = [];
    let bytes = 0;
    let omittedOlder = recentRuns.length > TIMELINE_RUNS;
    for (const run of recentRuns.slice(0, TIMELINE_RUNS)) {
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
