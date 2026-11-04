import { ConvexError } from "convex/values";
import type { UserIdentity } from "convex/server";
import type { Doc } from "./_generated/dataModel.js";
import type { QueryCtx } from "./_generated/server.js";

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
