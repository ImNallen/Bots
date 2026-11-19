import { parseToolCall } from "@bots/protocol";
import { ConvexError } from "convex/values";
import type { Doc } from "./_generated/dataModel.js";
import type { QueryCtx } from "./_generated/server.js";
import { computerOfOwner } from "./computers.js";

export async function currentCall(ctx: QueryCtx, run: Doc<"runs">) {
  const turn = await ctx.db.query("runEvents").withIndex("by_run_kind_seq", (q) => q.eq("runId", run._id).eq("body.kind", "assistantTurn")).order("desc").first();
  if (turn?.body.kind !== "assistantTurn") return null;
  for (const call of turn.body.toolCalls) {
    const result = await ctx.db.query("runEvents").withIndex("by_run_call_seq", (q) => q.eq("runId", run._id).eq("body.toolCallId", call.id).gt("seq", turn.seq)).first();
    if (result === null) return call;
  }
  return null;
}

export async function handoffContext(ctx: QueryCtx, run: Doc<"runs">, toolCallId: string) {
  if (run.state.kind !== "running" || run.cancelRequested || run.capability !== "full" || run.trigger !== "user" || run.scheduleId !== undefined) return null;
  const [bot, thread, computer, call] = await Promise.all([ctx.db.get(run.botId), ctx.db.get(run.threadId), computerOfOwner(ctx, run.ownerId), currentCall(ctx, run)]);
  if (bot?.ownerId !== run.ownerId || thread?.ownerId !== run.ownerId || thread.botId !== run.botId || thread.kind === "routine") return null;
  if (computer === null || computer.reset !== undefined || computer?.desiredVm?.removing === true || (computer?.updateFenceUntil ?? 0) > Date.now()) return null;
  if (run.computerGeneration !== (computer?.desiredVm?.generation ?? 0) || call?.id !== toolCallId) return null;
  const parsed = parseToolCall(call);
  return parsed.kind === "ok" && parsed.invocation.name === "request_takeover" ? { bot, reason: parsed.invocation.args.reason } : null;
}

export async function requireHandoffContext(ctx: QueryCtx, run: Doc<"runs">, toolCallId: string) {
  const context = await handoffContext(ctx, run, toolCallId);
  if (context === null) throw new ConvexError("This help request is no longer current");
  return context;
}

export async function handoffView(ctx: QueryCtx, run: Doc<"runs"> | null, toolCallId: string) {
  if (run === null) return { kind: "invalidated" as const };
  const result = await ctx.db.query("runEvents").withIndex("by_run_call_seq", (q) => q.eq("runId", run._id).eq("body.toolCallId", toolCallId)).first();
  if (result?.body.kind === "toolResult" && result.body.name === "request_takeover") {
    return { kind: result.body.outcome === "ok" ? "completed" as const : result.body.outcome === "denied" ? "declined" as const : "invalidated" as const };
  }
  const context = await handoffContext(ctx, run, toolCallId);
  if (context === null || run.handoff?.toolCallId !== toolCallId) return { kind: "invalidated" as const };
  return run.handoff.state.kind === "pending"
    ? { kind: "pending" as const, reason: context.reason, requestedAt: run.handoff.requestedAt }
    : { kind: "completed" as const, completedAt: run.handoff.state.completedAt };
}
