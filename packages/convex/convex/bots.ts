import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server.js";
import { requireIdentity } from "./identity.js";

const MAX_NAME_LENGTH = 64;

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
