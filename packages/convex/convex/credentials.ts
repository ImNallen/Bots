import { v } from "convex/values";
import type { Id } from "./_generated/dataModel.js";
import { mutation, query, type QueryCtx } from "./_generated/server.js";
import { requireIdentity, requireService } from "./identity.js";
import { modelProvider, type ModelProvider } from "./validators.js";

// A Mistral key's row has no provider, as every row did before Together.
function rowFor(ctx: QueryCtx, ownerId: Id<"users">, provider: ModelProvider | undefined) {
  const stored = provider === "together" ? "together" : undefined;
  return ctx.db
    .query("credentials")
    .withIndex("by_owner_and_provider", (q) => q.eq("ownerId", ownerId).eq("provider", stored))
    .unique();
}

export const status = query({
  args: { provider: v.optional(modelProvider) },
  handler: async (ctx, { provider }) => {
    const { user } = await requireIdentity(ctx);
    if (user === null) {
      return { configured: false, last4: null };
    }
    const row = await rowFor(ctx, user._id, provider);
    return row === null ? { configured: false, last4: null } : { configured: true, last4: row.last4 };
  },
});

export const store = mutation({
  args: {
    ownerId: v.id("users"),
    provider: v.optional(modelProvider),
    ciphertext: v.string(),
    iv: v.string(),
    tag: v.string(),
    keyVersion: v.number(),
    last4: v.string(),
  },
  handler: async (ctx, { ownerId, provider, ...fields }) => {
    await requireService(ctx);
    const existing = await rowFor(ctx, ownerId, provider);
    if (existing === null) {
      await ctx.db.insert("credentials", { ownerId, ...fields, ...(provider === "together" ? { provider } : {}) });
    } else {
      await ctx.db.patch(existing._id, fields);
    }
  },
});

export const remove = mutation({
  args: { ownerId: v.id("users"), provider: v.optional(modelProvider) },
  handler: async (ctx, { ownerId, provider }) => {
    await requireService(ctx);
    const existing = await rowFor(ctx, ownerId, provider);
    if (existing !== null) {
      await ctx.db.delete(existing._id);
    }
  },
});

export const ciphertextFor = query({
  args: { ownerId: v.id("users"), provider: v.optional(modelProvider) },
  handler: async (ctx, { ownerId, provider }) => {
    await requireService(ctx);
    return await rowFor(ctx, ownerId, provider);
  },
});
