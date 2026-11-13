import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server.js";
import { requireIdentity, requireService, upsertUser } from "./identity.js";
import { parseAbout } from "./memories.js";
import { isTimeZone } from "./scheduleTime.js";
import { followTimeZone } from "./schedules.js";
import { modelProvider, voiceModel } from "./validators.js";

export const ensureCurrent = mutation({
  args: { browserTimeZone: v.optional(v.string()) },
  handler: async (ctx, { browserTimeZone }) => {
    const { identity, user } = await requireIdentity(ctx);
    const { email, name: displayName } = identity;
    if (email === undefined || displayName === undefined) {
      throw new ConvexError("Token is missing the email or name claim");
    }
    const fields = { authSubject: identity.subject, email, displayName };
    const _id = await upsertUser(ctx, fields);
    if (user?.timeZone === undefined && browserTimeZone !== undefined && isTimeZone(browserTimeZone)) {
      await ctx.db.patch(_id, { timeZone: browserTimeZone });
    }
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

export const setTimeZone = mutation({
  args: { timeZone: v.string() },
  handler: async (ctx, { timeZone }) => {
    const { user } = await requireIdentity(ctx);
    if (user === null) {
      throw new ConvexError("User not found");
    }
    if (user.timeZone === timeZone) {
      return;
    }
    if (!isTimeZone(timeZone)) {
      throw new ConvexError("This is not a time zone");
    }
    await ctx.db.patch(user._id, { timeZone });
    await followTimeZone(ctx, user._id, timeZone, Date.now());
  },
});

// Mistral is the default, so choosing it clears the field, and a rollback to code without this field finds nothing to clear.
export const setModelProvider = mutation({
  args: { provider: modelProvider },
  handler: async (ctx, { provider }) => {
    const { user } = await requireIdentity(ctx);
    if (user === null) {
      throw new ConvexError("User not found");
    }
    await ctx.db.patch(user._id, { modelProvider: provider === "mistral" ? undefined : provider });
  },
});

// Voxtral is the default, so choosing it clears the field, as choosing Mistral clears modelProvider.
export const setVoiceModel = mutation({
  args: { model: voiceModel },
  handler: async (ctx, { model }) => {
    const { user } = await requireIdentity(ctx);
    if (user === null) {
      throw new ConvexError("User not found");
    }
    await ctx.db.patch(user._id, { voiceModel: model === "voxtral" ? undefined : model });
  },
});

export const voiceModelFor = query({
  args: { ownerId: v.id("users") },
  handler: async (ctx, { ownerId }) => {
    await requireService(ctx);
    return (await ctx.db.get(ownerId))?.voiceModel ?? "voxtral";
  },
});

export const ensureForService = mutation({
  args: { subject: v.string(), email: v.string(), displayName: v.string() },
  handler: async (ctx, { subject, email, displayName }) => {
    await requireService(ctx);
    return await upsertUser(ctx, { authSubject: subject, email, displayName });
  },
});
