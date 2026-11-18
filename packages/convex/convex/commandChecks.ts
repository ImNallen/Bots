import { v } from "convex/values";
import { internalMutation } from "./_generated/server.js";

export const ageApproval = internalMutation({
  args: { approvalId: v.id("approvals") },
  handler: async (ctx, { approvalId }) => {
    await ctx.db.patch(approvalId, { requestedAt: Date.now() - 25 * 60 * 60 * 1000 });
  },
});

export const deadline = internalMutation({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }) => {
    await ctx.db.patch(runId, { deadlineAt: 0 });
  },
});
