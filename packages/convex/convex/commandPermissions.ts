import { parseToolCall } from "@bots/protocol";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { QueryCtx } from "./_generated/server.js";
import { decideByRules } from "./automaticRules.js";
import { computerOfOwner } from "./computers.js";
import type { CommandScope, ShellSubject } from "./validators.js";

export const MAX_SAVED_COMMANDS = 16;

export function sameScope(a: CommandScope, b: CommandScope): boolean {
  return a.computerId === b.computerId && a.generation === b.generation && a.workspace === b.workspace;
}

export async function eligibleShell(ctx: QueryCtx, run: Doc<"runs">, toolCallId: string) {
  const now = Date.now();
  if (run.capability !== "full" || run.cancelRequested || run.state.kind !== "running" || run.state.leaseUntil <= now || (run.deadlineAt !== undefined && run.deadlineAt <= now)) return null;
  const bot = await ctx.db.get(run.botId);
  const computer = await computerOfOwner(ctx, run.ownerId);
  if (bot === null || bot.ownerId !== run.ownerId || (bot.approvalLevel ?? "automatic") !== "automatic" || computer === null || computer.reset !== undefined || computer.desiredVm?.removing === true || (computer.updateFenceUntil ?? 0) > now) return null;
  const generation = computer.desiredVm?.generation ?? 0;
  if ((run.computerGeneration ?? 0) !== generation) return null;
  const turn = await ctx.db.query("runEvents").withIndex("by_run_kind_seq", q => q.eq("runId", run._id).eq("body.kind", "assistantTurn")).order("desc").first();
  if (turn?.body.kind !== "assistantTurn") return null;
  const call = turn.body.toolCalls.find(call => call.id === toolCallId);
  if (call === undefined || call.name !== "shell") return null;
  const result = await ctx.db.query("runEvents").withIndex("by_run_call_seq", q => q.eq("runId", run._id).eq("body.toolCallId", toolCallId)).first();
  if (result !== null) return null;
  const parsed = parseToolCall(call);
  if (parsed.kind !== "ok" || parsed.invocation.name !== "shell") return null;
  const scope = { computerId: computer._id, generation, workspace: `/workspace/${bot._id}` };
  const policy = decideByRules({ invocation: parsed.invocation, workspace: scope.workspace, aim: null, page: null });
  if (policy.run || policy.permission !== "shellFallback") return null;
  const subject: ShellSubject = { eventId: turn._id, arguments: call.arguments, command: parsed.invocation.args.command, scope };
  return { bot, subject };
}

export async function matchingCommand(ctx: QueryCtx, args: { runId: Id<"runs">; toolCallId: string; leaseToken: string }) {
  const run = await ctx.db.get(args.runId);
  if (run?.state.kind !== "running" || run.state.leaseToken !== args.leaseToken) return null;
  const approval = await ctx.db.query("approvals").withIndex("by_run_call", q => q.eq("runId", args.runId).eq("toolCallId", args.toolCallId)).unique();
  if (approval !== null) return null;
  const eligible = await eligibleShell(ctx, run, args.toolCallId);
  if (eligible === null) return null;
  const saved = eligible.bot.savedCommands;
  if (saved === undefined || !sameScope(saved.scope, eligible.subject.scope)) return null;
  const entry = saved.entries.find(entry => entry.command === eligible.subject.command);
  return entry === undefined ? null : { ...eligible, entry };
}
