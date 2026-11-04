import { ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server.js";
import { requireIdentity } from "./identity.js";

export const ensureCurrent = mutation({
  args: {},
  handler: async (ctx) => {
    const { identity, user } = await requireIdentity(ctx);
    const { email, name: displayName } = identity;
    if (email === undefined || displayName === undefined) {
      throw new ConvexError("Token is missing the email or name claim");
    }
    const fields = { authSubject: identity.subject, email, displayName };
    if (user === null) {
      const _id = await ctx.db.insert("users", fields);
      return { _id, ...fields };
    }
    if (user.email !== email || user.displayName !== displayName) {
      await ctx.db.patch(user._id, { email, displayName });
    }
    return { _id: user._id, ...fields };
  },
});

export const current = query({
  args: {},
  handler: async (ctx) => {
    const { user } = await requireIdentity(ctx);
    return user;
  },
});
