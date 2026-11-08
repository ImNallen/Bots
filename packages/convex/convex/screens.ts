import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel.js";
import { query, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { requireService } from "./identity.js";
import type { KeptScreen } from "./validators.js";

async function screenOf(ctx: QueryCtx, runId: Id<"runs">): Promise<Doc<"screens"> | null> {
  return await ctx.db
    .query("screens")
    .withIndex("by_run", (q) => q.eq("runId", runId))
    .unique();
}

// append calls this under the run's lease and sequence fence, so each run has one writer. A routine never keeps a picture, because
// the desktop shows the owner's logged-in pages.
export async function keepScreen(ctx: MutationCtx, run: Doc<"runs">, toolCallId: string, screen: KeptScreen): Promise<void> {
  if (run.capability !== "full") {
    return;
  }
  const row = { runId: run._id, ownerId: run.ownerId, toolCallId, view: screen.view, ...(screen.image === undefined ? {} : { image: screen.image }) };
  const existing = await screenOf(ctx, run._id);
  if (existing === null) {
    await ctx.db.insert("screens", row);
  } else {
    await ctx.db.replace(existing._id, row);
  }
}

export async function deleteScreen(ctx: MutationCtx, runId: Id<"runs">): Promise<void> {
  const existing = await screenOf(ctx, runId);
  if (existing !== null) {
    await ctx.db.delete(existing._id);
  }
}

export const ofRun = query({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }) => {
    await requireService(ctx);
    const row = await screenOf(ctx, runId);
    return row === null ? null : { toolCallId: row.toolCallId, view: row.view, image: row.image ?? null };
  },
});
