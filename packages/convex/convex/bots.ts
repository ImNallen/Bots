import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { internalMutation, mutation, query, type MutationCtx } from "./_generated/server.js";
import { requireIdentity, requireService } from "./identity.js";
import { isActive } from "./threads.js";
import { approvalLevel } from "./validators.js";

const MAX_NAME_LENGTH = 64;
const DEFAULT_APPROVAL_LEVEL = "outside";
// Long enough to log in to a site. A phone that sleeps or a forgotten tab stops renewing this, and the bot carries on.
const TAKEOVER_MS = 15 * 60 * 1000;
// One event is at most 1 MiB, so a batch stays well under what a mutation may read.
const PURGE_BATCH = 8;

export const list = query({
  args: {},
  handler: async (ctx) => {
    const { user } = await requireIdentity(ctx);
    if (user === null) {
      return [];
    }
    return await ctx.db
      .query("bots")
      .withIndex("by_owner", (q) => q.eq("ownerId", user._id))
      .collect();
  },
});

// The id comes from a URL, so a malformed one reads as a bot that does not exist.
export const get = query({
  args: { botId: v.string() },
  handler: async (ctx, { botId }) => {
    const { user } = await requireIdentity(ctx);
    const id = ctx.db.normalizeId("bots", botId);
    const bot = id === null ? null : await ctx.db.get(id);
    if (user === null || bot === null || bot.ownerId !== user._id) {
      return null;
    }
    return bot;
  },
});

export const create = mutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const { user } = await requireIdentity(ctx);
    if (user === null) {
      throw new ConvexError("Call users.ensureCurrent before creating a bot");
    }
    const trimmed = name.trim();
    if (trimmed === "") {
      throw new ConvexError("Name cannot be empty");
    }
    if (trimmed.length > MAX_NAME_LENGTH) {
      throw new ConvexError(`Name cannot be longer than ${MAX_NAME_LENGTH} characters`);
    }
    return await ctx.db.insert("bots", { ownerId: user._id, name: trimmed });
  },
});

// The orchestrator asks this before it opens a screen, so a bot's screen reaches only the bot's owner.
export const ownerForViewer = query({
  args: { botId: v.string(), viewerSubject: v.string() },
  handler: async (ctx, { botId, viewerSubject }) => {
    await requireService(ctx);
    const id = ctx.db.normalizeId("bots", botId);
    if (id === null) {
      return null;
    }
    const bot = await ctx.db.get(id);
    if (bot === null) {
      return null;
    }
    const viewer = await ctx.db
      .query("users")
      .withIndex("by_auth_subject", (q) => q.eq("authSubject", viewerSubject))
      .unique();
    return viewer?._id === bot.ownerId ? { ownerId: bot.ownerId, takeoverUntil: bot.takeoverUntil ?? 0 } : null;
  },
});

async function requireOwnedBot(ctx: MutationCtx, botId: Id<"bots">) {
  const { user } = await requireIdentity(ctx);
  const bot = await ctx.db.get(botId);
  if (user === null || bot === null || bot.ownerId !== user._id) {
    throw new ConvexError("Bot not found");
  }
  return bot;
}

// The web app calls this to start and then to renew, so a renewal is the same call.
export const takeOver = mutation({
  args: { botId: v.id("bots") },
  handler: async (ctx, { botId }) => {
    await requireOwnedBot(ctx, botId);
    const takeoverUntil = Date.now() + TAKEOVER_MS;
    await ctx.db.patch(botId, { takeoverUntil });
    return takeoverUntil;
  },
});

export const releaseTakeover = mutation({
  args: { botId: v.id("bots") },
  handler: async (ctx, { botId }) => {
    await requireOwnedBot(ctx, botId);
    await ctx.db.patch(botId, { takeoverUntil: undefined });
  },
});

export const takeoverUntil = query({
  args: { botId: v.id("bots") },
  handler: async (ctx, { botId }) => {
    await requireService(ctx);
    return (await ctx.db.get(botId))?.takeoverUntil ?? 0;
  },
});

export const setApprovalLevel = mutation({
  args: { botId: v.id("bots"), level: approvalLevel },
  handler: async (ctx, { botId, level }) => {
    await requireOwnedBot(ctx, botId);
    await ctx.db.patch(botId, { approvalLevel: level });
  },
});

export const approvalLevelFor = query({
  args: { botId: v.id("bots") },
  handler: async (ctx, { botId }) => {
    await requireService(ctx);
    return (await ctx.db.get(botId))?.approvalLevel ?? DEFAULT_APPROVAL_LEVEL;
  },
});

// The bot goes at once, so nothing can start on it, and purge takes its history in batches. A bot in use refuses, because a
// run or a take-over would lose its desktop midway.
export const remove = mutation({
  args: { botId: v.id("bots") },
  handler: async (ctx, { botId }): Promise<void> => {
    const bot = await requireOwnedBot(ctx, botId);
    if ((bot.takeoverUntil ?? 0) > Date.now()) {
      throw new ConvexError("Give back this bot's screen before you delete it");
    }
    for await (const thread of ctx.db.query("threads").withIndex("by_bot", (q) => q.eq("botId", botId))) {
      const latest = await ctx.db
        .query("runs")
        .withIndex("by_thread", (q) => q.eq("threadId", thread._id))
        .order("desc")
        .first();
      if (latest !== null && isActive(latest.state)) {
        throw new ConvexError("This bot has an active run. Stop it before you delete it");
      }
    }
    await ctx.db.delete(botId);
    await ctx.scheduler.runAfter(0, internal.bots.purge, { botId });
    // With no VM, nothing would ever read this row.
    const computer = await ctx.db
      .query("computers")
      .withIndex("by_owner", (q) => q.eq("ownerId", bot.ownerId))
      .first();
    if (computer?.desiredVm !== undefined) {
      await ctx.db.insert("removedBots", { ownerId: bot.ownerId, botId });
    }
  },
});

// Each step takes one batch and schedules the next. A thread goes last, so a thread that is gone means its whole history is.
export const purge = internalMutation({
  args: { botId: v.id("bots") },
  handler: async (ctx, { botId }): Promise<void> => {
    const thread = await ctx.db
      .query("threads")
      .withIndex("by_bot", (q) => q.eq("botId", botId))
      .first();
    if (thread === null) {
      return;
    }
    const run = await ctx.db
      .query("runs")
      .withIndex("by_thread", (q) => q.eq("threadId", thread._id))
      .first();
    const batch =
      run === null
        ? await ctx.db
            .query("approvals")
            .withIndex("by_thread_state", (q) => q.eq("threadId", thread._id))
            .take(PURGE_BATCH)
        : [
            ...(await ctx.db
              .query("runEvents")
              .withIndex("by_run_seq", (q) => q.eq("runId", run._id))
              .take(PURGE_BATCH)),
            ...(await ctx.db
              .query("runStreams")
              .withIndex("by_run", (q) => q.eq("runId", run._id))
              .take(PURGE_BATCH)),
          ];
    const documents = batch.length > 0 ? batch : [run ?? thread];
    await Promise.all(documents.map((document) => ctx.db.delete(document._id)));
    await ctx.scheduler.runAfter(0, internal.bots.purge, { botId });
  },
});

// The reconcile loop calls this after a VM has lost these bots' files, which the owner's id scopes to that VM.
export const recordForgotten = mutation({
  args: { ownerId: v.id("users"), botIds: v.array(v.id("bots")) },
  handler: async (ctx, { ownerId, botIds }) => {
    await requireService(ctx);
    const forgotten = new Set<string>(botIds);
    for await (const row of ctx.db.query("removedBots").withIndex("by_owner", (q) => q.eq("ownerId", ownerId))) {
      if (forgotten.has(row.botId)) {
        await ctx.db.delete(row._id);
      }
    }
  },
});
