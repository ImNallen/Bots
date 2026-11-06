import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server.js";
import { requireIdentity, requireService, upsertUser } from "./identity.js";
import { parseAbout } from "./memories.js";

export const ensureCurrent = mutation({
  args: {},
  handler: async (ctx) => {
    const { identity } = await requireIdentity(ctx);
    const { email, name: displayName } = identity;
    if (email === undefined || displayName === undefined) {
      throw new ConvexError("Token is missing the email or name claim");
    }
    const fields = { authSubject: identity.subject, email, displayName };
    const _id = await upsertUser(ctx, fields);
    return { _id, ...fields };
  },
});

export const current = query({
  args: {},
  handler: async (ctx) => {
    const { user } = await requireIdentity(ctx);
    return user;
  },
});

export const setAbout = mutation({
  args: { about: v.string() },
  handler: async (ctx, { about }) => {
    const { user } = await requireIdentity(ctx);
    if (user === null) {
      throw new ConvexError("User not found");
    }
    await ctx.db.patch(user._id, { about: parseAbout(about) });
  },
});

export const ensureForService = mutation({
  args: { subject: v.string(), email: v.string(), displayName: v.string() },
  handler: async (ctx, { subject, email, displayName }) => {
    await requireService(ctx);
    return await upsertUser(ctx, { authSubject: subject, email, displayName });
  },
});
