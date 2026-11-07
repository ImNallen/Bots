import { v } from "convex/values";
import { internalQuery } from "./_generated/server.js";

export const storageForCheck = internalQuery({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, { storageId }) => ({
    exists: (await ctx.db.system.get(storageId)) !== null,
    url: await ctx.storage.getUrl(storageId),
  }),
});
