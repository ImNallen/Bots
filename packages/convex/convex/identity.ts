import { ConvexError } from "convex/values";
import type { UserIdentity } from "convex/server";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";

// User subjects always start with dev: or tailscale:, so no user token can carry this one.
const SERVICE_SUBJECT = "service:orchestrator";

export type CurrentIdentity = {
  identity: UserIdentity;
  user: Doc<"users"> | null;
};

export async function requireIdentity(ctx: QueryCtx): Promise<CurrentIdentity> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) {
    throw new ConvexError("Not authenticated");
  }
  const user = await ctx.db
    .query("users")
    .withIndex("by_auth_subject", (q) => q.eq("authSubject", identity.subject))
    .unique();
  return { identity, user };
}

export async function requireOwnedBot(ctx: QueryCtx, botId: Id<"bots">): Promise<Doc<"bots">> {
  const { user } = await requireIdentity(ctx);
  const bot = await ctx.db.get(botId);
  if (user === null || bot === null || bot.ownerId !== user._id) {
    throw new ConvexError("Bot not found");
  }
  return bot;
}

export async function requireService(ctx: QueryCtx): Promise<void> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity?.subject !== SERVICE_SUBJECT) {
    throw new ConvexError("Not authorized");
  }
}

export async function upsertUser(
  ctx: MutationCtx,
  fields: { authSubject: string; email: string; displayName: string },
): Promise<Id<"users">> {
  const user = await ctx.db
    .query("users")
    .withIndex("by_auth_subject", (q) => q.eq("authSubject", fields.authSubject))
    .unique();
  if (user === null) {
    return await ctx.db.insert("users", fields);
  }
  if (user.email !== fields.email || user.displayName !== fields.displayName) {
    await ctx.db.patch(user._id, { email: fields.email, displayName: fields.displayName });
  }
  return user._id;
}
