import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel.js";
import { query, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { requireIdentity, requireService } from "./identity.js";
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

// The owner's approval card for a desktop input: the run's newest look, with the box that the card outlines. Only for a pending
// approval of the owner's own run, so a picture of the desktop reaches nobody else, and none after the answer.
export const forApproval = query({
  args: { approvalId: v.id("approvals") },
  handler: async (ctx, { approvalId }) => {
    const { user } = await requireIdentity(ctx);
    const approval = await ctx.db.get(approvalId);
    if (user === null || approval === null || approval.ownerId !== user._id || approval.state !== "pending" || approval.subject === undefined) {
      return null;
    }
    const row = await screenOf(ctx, approval.runId);
    if (row === null || row.image === undefined) {
      return null;
    }
    const { width, height } = JSON.parse(row.view) as { width: number; height: number };
    return { image: row.image, width, height, box: approval.box ?? null };
  },
});
