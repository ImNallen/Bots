import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel.js";
import { mutation, query, type MutationCtx } from "./_generated/server.js";
import { requireIdentity, requireService } from "./identity.js";

const MAX_NAME_LENGTH = 64;
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
