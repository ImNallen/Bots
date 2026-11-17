import { ConvexError, v } from "convex/values";
import { PAGE_LIMITS } from "@bots/protocol/page-limits";
import type { Doc, Id } from "./_generated/dataModel.js";
import { query, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { requireService } from "./identity.js";

async function pageOf(ctx: QueryCtx, runId: Id<"runs">): Promise<Doc<"pages"> | null> {
  return await ctx.db.query("pages").withIndex("by_run", (q) => q.eq("runId", runId)).unique();
}

export async function deletePage(ctx: MutationCtx, runId: Id<"runs">): Promise<void> {
  const existing = await pageOf(ctx, runId);
  if (existing !== null) await ctx.db.delete(existing._id);
}

export async function keepPage(ctx: MutationCtx, run: Doc<"runs">, args: { toolCallId: string; seq: number; view: string | null }): Promise<void> {
  if (args.view === null) {
    await deletePage(ctx, run._id);
    return;
  }
  if (new TextEncoder().encode(args.view).length > PAGE_LIMITS.jsonBytes) throw new ConvexError("Page too large");
  const row = { runId: run._id, ownerId: run.ownerId, toolCallId: args.toolCallId, seq: args.seq, view: args.view };
  const existing = await pageOf(ctx, run._id);
  if (existing === null) await ctx.db.insert("pages", row);
  else await ctx.db.replace(existing._id, row);
}

export const ofRun = query({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }) => {
    await requireService(ctx);
    const run = await ctx.db.get(runId);
    if (run === null) return null;
    const row = await pageOf(ctx, runId);
    return row === null || row.ownerId !== run.ownerId ? null : { toolCallId: row.toolCallId, seq: row.seq, view: row.view };
  },
});
