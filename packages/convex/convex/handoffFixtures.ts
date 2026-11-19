import { v } from "convex/values";
import { internalMutation } from "./_generated/server.js";
import { computerOfOwner } from "./computers.js";

export const alter = internalMutation({
  args: { runId: v.id("runs"), mode: v.union(v.literal("expireInput"), v.literal("readOnly"), v.literal("generation"), v.literal("removeBot"), v.literal("reset"), v.literal("clearReset"), v.literal("views")) },
  handler: async (ctx, { runId, mode }) => {
    const run = await ctx.db.get(runId);
    if (run === null) throw new Error("Missing fixture run");
    const computer = await computerOfOwner(ctx, run.ownerId);
    switch (mode) {
      case "expireInput": await ctx.db.patch(run.botId, { takeoverUntil: 0 }); break;
      case "readOnly": await ctx.db.patch(runId, { capability: "readOnly" }); break;
      case "generation": await ctx.db.patch(runId, { computerGeneration: 999 }); break;
      case "removeBot": await ctx.db.delete(run.botId); break;
      case "reset": if (computer !== null) await ctx.db.patch(computer._id, { reset: { generation: 1, requestedAt: Date.now() } }); break;
      case "clearReset": if (computer !== null) await ctx.db.patch(computer._id, { reset: undefined }); break;
      case "views":
        await ctx.db.insert("pages", { runId, ownerId: run.ownerId, toolCallId: "old", seq: 0, view: "old page targets" });
        await ctx.db.insert("screens", { runId, ownerId: run.ownerId, toolCallId: "old", view: "old screen targets" });
        break;
    }
  },
});
