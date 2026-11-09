import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api.js";
import { internalMutation, mutation, query } from "./_generated/server.js";
import { TEXT_READ_BYTES, decideActivity, lastMessageOf, newestEventsUpToText } from "./activity.js";
import { requireIdentity, requireOwnedBot, requireService } from "./identity.js";
import { notesOf, promptNotes } from "./memories.js";
import { parseBotIdentity, parseBotName, parseBotProfile } from "./profile.js";
import { promptRoutines, routinesOfBot } from "./schedules.js";
import { activeRunOfBot, chatThreadOf, purgeThreadBatch } from "./threads.js";
import { approvalLevel, botColor, botShape } from "./validators.js";

const DEFAULT_APPROVAL_LEVEL = "automatic";
// Long enough to log in to a site. A phone that sleeps or a forgotten tab stops renewing this, and the bot carries on.
const TAKEOVER_MS = 15 * 60 * 1000;

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

export const overview = query({
  args: {},
  handler: async (ctx) => {
    const { user } = await requireIdentity(ctx);
    if (user === null) {
      return [];
    }
    const bots = await ctx.db
      .query("bots")
      .withIndex("by_owner", (q) => q.eq("ownerId", user._id))
      .order("desc")
      .collect();
    const pending = await ctx.db
      .query("approvals")
      .withIndex("by_owner_state", (q) => q.eq("ownerId", user._id).eq("state", "pending"))
      .collect();
    const runsWithPendingApproval = new Set<string>(pending.map((approval) => approval.runId));
    const budget = { bytes: TEXT_READ_BYTES };
    const rows = [];
    for (const bot of bots) {
      const thread = await chatThreadOf(ctx, bot._id);
      const chatRun =
        thread === null
          ? null
          : await ctx.db
              .query("runs")
              .withIndex("by_thread", (q) => q.eq("threadId", thread._id))
              .order("desc")
              .first();
      const currentRun = (await activeRunOfBot(ctx, bot._id)) ?? chatRun;
      const chatEvents = chatRun === null ? [] : await newestEventsUpToText(ctx, chatRun._id, budget);
      const newestEvents = currentRun === null || currentRun._id === chatRun?._id ? chatEvents : await newestEventsUpToText(ctx, currentRun._id, budget);
      rows.push({
        lastRunAt: currentRun?._creationTime ?? 0,
        row: {
          _id: bot._id,
          name: bot.name,
          title: bot.title,
          shape: bot.shape,
          color: bot.color,
          // The end time and not a comparison, because Convex does not rerun a query as time passes. The page decides when it ends.
          takeoverUntil: bot.takeoverUntil ?? null,
          activity: decideActivity({
            hasPendingApproval: currentRun !== null && runsWithPendingApproval.has(currentRun._id),
            runState: currentRun?.state ?? null,
            newestEvents,
          }),
          lastMessage: lastMessageOf(chatEvents),
        },
      });
    }
    return rows.sort((a, b) => b.lastRunAt - a.lastRunAt).map(({ row }) => row);
  },
});

export const create = mutation({
  args: { name: v.string(), shape: v.optional(botShape), color: v.optional(botColor) },
  handler: async (ctx, { name, shape, color }) => {
    const { user } = await requireIdentity(ctx);
    if (user === null) {
      throw new ConvexError("Call users.ensureCurrent before creating a bot");
    }
    return await ctx.db.insert("bots", { ownerId: user._id, name: parseBotName(name), shape, color });
  },
});

export const setHighlight = mutation({
  args: { botId: v.id("bots"), position: v.union(v.number(), v.null()) },
  handler: async (ctx, { botId, position }) => {
    const bot = await requireOwnedBot(ctx, botId);
    const user = await ctx.db.get(bot.ownerId);
    if (user === null) throw new ConvexError("User not found");
    const ids = (user.highlightedBotIds ?? []).filter((id) => id !== botId);
    if (position !== null) {
      if (!Number.isInteger(position) || position < 0 || position > 3) {
        throw new ConvexError("Choose a highlight position from 0 to 3");
      }
      if (ids.length >= 4) throw new ConvexError("Highlight up to four bots. Drag one back to the list first.");
      ids.splice(position, 0, botId);
    }
    await ctx.db.patch(user._id, { highlightedBotIds: ids });
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

export const setCharacter = mutation({
  args: { botId: v.id("bots"), shape: botShape, color: botColor },
  handler: async (ctx, { botId, shape, color }) => {
    await requireOwnedBot(ctx, botId);
    await ctx.db.patch(botId, { shape, color });
  },
});

export const setProfile = mutation({
  args: { botId: v.id("bots"), name: v.string(), title: v.string(), description: v.string() },
  handler: async (ctx, { botId, ...fields }) => {
    await requireOwnedBot(ctx, botId);
    await ctx.db.patch(botId, parseBotProfile(fields));
  },
});

export const setIdentity = mutation({
  args: { botId: v.id("bots"), name: v.string(), title: v.string() },
  handler: async (ctx, { botId, ...fields }) => {
    await requireOwnedBot(ctx, botId);
    await ctx.db.patch(botId, parseBotIdentity(fields));
  },
});

export const promptFor = query({
  args: { botId: v.id("bots") },
  handler: async (ctx, { botId }) => {
    await requireService(ctx);
    const bot = await ctx.db.get(botId);
    const owner = bot === null ? null : await ctx.db.get(bot.ownerId);
    return {
      name: bot?.name ?? "Bot",
      title: bot?.title,
      description: bot?.description,
      about: owner?.about,
      notes: promptNotes(await notesOf(ctx, botId)),
      timeZone: owner?.timeZone,
      routines: promptRoutines(await routinesOfBot(ctx, botId), owner?.timeZone),
    };
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
    if ((await activeRunOfBot(ctx, botId)) !== null) {
      throw new ConvexError("This bot has an active run. Stop it before you delete it");
    }
    for (const note of await notesOf(ctx, botId)) {
      await ctx.db.delete(note._id);
    }
    for (const routine of await routinesOfBot(ctx, botId)) {
      await ctx.db.delete(routine._id);
    }
    const user = await ctx.db.get(bot.ownerId);
    if (user?.highlightedBotIds?.includes(botId)) {
      await ctx.db.patch(user._id, { highlightedBotIds: user.highlightedBotIds.filter((id) => id !== botId) });
    }
    await ctx.db.delete(botId);
    await ctx.scheduler.runAfter(0, internal.bots.purge, { botId });
    await ctx.scheduler.runAfter(0, internal.attachments.purgeBot, { botId });
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
    await purgeThreadBatch(ctx, thread._id);
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
