import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { attachmentProblem } from "./attachmentFiles.js";
import { requireIdentity, requireService } from "./identity.js";
import { attachmentContentType } from "./validators.js";

async function botForSubject(ctx: QueryCtx, botId: Id<"bots">, subject: string) {
  const bot = await ctx.db.get(botId);
  const owner = bot === null ? null : await ctx.db.get(bot.ownerId);
  if (bot === null || owner?.authSubject !== subject) throw new ConvexError("Bot not found");
  return bot;
}

export async function deleteAttachment(ctx: MutationCtx, file: Doc<"attachments">) {
  if (file.state.kind !== "uploading") await ctx.storage.delete(file.state.storageId);
  await ctx.db.delete(file._id);
}

export const beginForService = mutation({
  args: { botId: v.string(), subject: v.string(), name: v.string(), contentType: attachmentContentType, size: v.number() },
  handler: async (ctx, args) => {
    await requireService(ctx);
    const botId = ctx.db.normalizeId("bots", args.botId);
    if (botId === null) throw new ConvexError("Bot not found");
    const bot = await botForSubject(ctx, botId, args.subject);
    const problem = attachmentProblem({ name: args.name, type: args.contentType, size: args.size });
    if (problem !== null) throw new ConvexError(problem);
    const pending = await Promise.all((["uploading", "ready"] as const).map((kind) => ctx.db.query("attachments").withIndex("by_bot_state", (q) => q.eq("botId", botId).eq("state.kind", kind)).take(24)));
    if (pending.flat().length >= 24) throw new ConvexError("This bot has too many unsent files. Remove an attachment or try again later.");
    const id = await ctx.db.insert("attachments", { ownerId: bot.ownerId, botId: bot._id, name: args.name, contentType: args.contentType, size: args.size, state: { kind: "uploading" } });
    await ctx.scheduler.runAfter(24 * 60 * 60 * 1000, internal.attachments.expire, { id });
    return { id, uploadUrl: await ctx.storage.generateUploadUrl() };
  },
});

export const completeForService = mutation({
  args: { id: v.id("attachments"), storageId: v.string() },
  handler: async (ctx, { id, storageId: rawStorageId }) => {
    await requireService(ctx);
    const storageId = ctx.db.system.normalizeId("_storage", rawStorageId);
    if (storageId === null) throw new ConvexError("The file upload did not finish. Try again.");
    const file = await ctx.db.get(id);
    if (file === null) {
      await ctx.storage.delete(storageId);
      return { kind: "failed" as const };
    }
    const metadata = await ctx.db.system.get(storageId);
    const bot = await ctx.db.get(file.botId);
    const result = { id, name: file.name, contentType: file.contentType, size: file.size };
    if (bot !== null && file.state.kind !== "uploading" && file.state.storageId === storageId) return { kind: "ready" as const, file: result };
    if (bot === null || file.state.kind !== "uploading" || metadata?.size !== file.size || metadata.contentType !== file.contentType) {
      await ctx.storage.delete(storageId);
      return { kind: "failed" as const };
    }
    await ctx.db.patch(id, { state: { kind: "ready", storageId } });
    return { kind: "ready" as const, file: result };
  },
});

export const downloadForService = query({
  args: { id: v.string(), subject: v.string() },
  handler: async (ctx, { id: rawId, subject }) => {
    await requireService(ctx);
    const id = ctx.db.normalizeId("attachments", rawId);
    if (id === null) return null;
    const file = await ctx.db.get(id);
    if (file === null) return null;
    const bot = await ctx.db.get(file.botId);
    const owner = bot === null ? null : await ctx.db.get(bot.ownerId);
    if (owner?.authSubject !== subject || file.state.kind === "uploading") return null;
    return { name: file.name, contentType: file.contentType, size: file.size, url: await ctx.storage.getUrl(file.state.storageId) };
  },
});

export const forModel = query({
  args: { id: v.id("attachments"), botId: v.id("bots"), ownerId: v.id("users") },
  handler: async (ctx, { id, botId, ownerId }) => {
    await requireService(ctx);
    const file = await ctx.db.get(id);
    const bot = await ctx.db.get(botId);
    if (file === null || bot?.ownerId !== ownerId || file.botId !== botId || file.ownerId !== ownerId || file.state.kind !== "sent") return null;
    return { name: file.name, contentType: file.contentType, size: file.size, url: await ctx.storage.getUrl(file.state.storageId) };
  },
});

export const discard = mutation({
  args: { id: v.id("attachments") },
  handler: async (ctx, { id }) => {
    const { user } = await requireIdentity(ctx);
    const file = await ctx.db.get(id);
    if (file === null) return;
    if (file.ownerId !== user?._id) throw new ConvexError("Attachment not found");
    if (file.state.kind === "sent") throw new ConvexError("This file is already part of a message");
    await deleteAttachment(ctx, file);
  },
});

export const draft = query({
  args: { id: v.string(), botId: v.id("bots") },
  handler: async (ctx, { id: rawId, botId }) => {
    const { user } = await requireIdentity(ctx);
    const id = ctx.db.normalizeId("attachments", rawId);
    const file = id === null ? null : await ctx.db.get(id);
    if (file === null || file.botId !== botId || file.ownerId !== user?._id || file.state.kind !== "ready") return null;
    return { id: file._id, name: file.name, contentType: file.contentType, size: file.size };
  },
});

export const expire = internalMutation({
  args: { id: v.id("attachments") },
  handler: async (ctx, { id }) => {
    const file = await ctx.db.get(id);
    if (file !== null && file.state.kind !== "sent") await deleteAttachment(ctx, file);
  },
});

export const purgeBot = internalMutation({
  args: { botId: v.id("bots") },
  handler: async (ctx, { botId }) => {
    const files = await ctx.db.query("attachments").withIndex("by_bot_state", (q) => q.eq("botId", botId)).take(8);
    for (const file of files) await deleteAttachment(ctx, file);
    if (files.length === 8) await ctx.scheduler.runAfter(0, internal.attachments.purgeBot, { botId });
  },
});
