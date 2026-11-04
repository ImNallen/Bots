import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server.js";
import { requireService, upsertUser } from "./identity.js";

export const register = mutation({
  args: {
    ownerSubject: v.string(),
    email: v.string(),
    displayName: v.string(),
    tokenHash: v.string(),
  },
  handler: async (ctx, { ownerSubject, email, displayName, tokenHash }) => {
    await requireService(ctx);
    const ownerId = await upsertUser(ctx, { authSubject: ownerSubject, email, displayName });
    const holder = await ctx.db
      .query("computers")
      .withIndex("by_token_hash", (q) => q.eq("tokenHash", tokenHash))
      .first();
    if (holder !== null && holder.ownerId !== ownerId) {
      throw new ConvexError("This computer token belongs to another owner");
    }
    const existing = await ctx.db
      .query("computers")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .unique();
    if (existing === null) {
      const computerId = await ctx.db.insert("computers", { ownerId, tokenHash });
      return { ownerId, computerId };
    }
    if (existing.tokenHash !== tokenHash) {
      await ctx.db.patch(existing._id, { tokenHash });
    }
    return { ownerId, computerId: existing._id };
  },
});

export const byTokenHash = query({
  args: { tokenHash: v.string() },
  handler: async (ctx, { tokenHash }) => {
    await requireService(ctx);
    const computer = await ctx.db
      .query("computers")
      .withIndex("by_token_hash", (q) => q.eq("tokenHash", tokenHash))
      .first();
    return computer === null ? null : { computerId: computer._id, ownerId: computer.ownerId };
  },
});
