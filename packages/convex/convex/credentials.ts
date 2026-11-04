import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";
import { requireIdentity, requireService } from "./identity.js";

export const status = query({
  args: {},
  handler: async (ctx) => {
    const { user } = await requireIdentity(ctx);
    if (user === null) {
      return { configured: false, last4: null };
    }
    const row = await ctx.db
      .query("credentials")
      .withIndex("by_owner", (q) => q.eq("ownerId", user._id))
      .unique();
    return row === null ? { configured: false, last4: null } : { configured: true, last4: row.last4 };
  },
});

export const store = mutation({
  args: {
    ownerId: v.id("users"),
    ciphertext: v.string(),
    iv: v.string(),
    tag: v.string(),
    keyVersion: v.number(),
    last4: v.string(),
  },
  handler: async (ctx, { ownerId, ...fields }) => {
    await requireService(ctx);
    const existing = await ctx.db
      .query("credentials")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .unique();
    if (existing === null) {
      await ctx.db.insert("credentials", { ownerId, ...fields });
    } else {
      await ctx.db.patch(existing._id, fields);
    }
  },
});

export const remove = mutation({
  args: { ownerId: v.id("users") },
  handler: async (ctx, { ownerId }) => {
    await requireService(ctx);
    const existing = await ctx.db
      .query("credentials")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .unique();
    if (existing !== null) {
      await ctx.db.delete(existing._id);
    }
  },
});

export const ciphertextFor = query({
  args: { ownerId: v.id("users") },
  handler: async (ctx, { ownerId }) => {
    await requireService(ctx);
    return await ctx.db
      .query("credentials")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .unique();
  },
});
