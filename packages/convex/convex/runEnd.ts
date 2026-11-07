import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import type { TerminalRunState } from "./validators.js";

export const DEADLINE_FAILURE: TerminalRunState = { kind: "failed", reason: "The routine ran past its 30 minute limit" };
const LATE_RUNS_PER_TICK = 32;

const UNANSWERED_CALL_OUTPUT =
  "The run stopped before this call reported a result, so the outcome is unknown. It may have run, and it may still be running.";

export async function deleteStream(ctx: MutationCtx, runId: Id<"runs">): Promise<void> {
  const stream = await ctx.db
    .query("runStreams")
    .withIndex("by_run", (q) => q.eq("runId", runId))
    .unique();
  if (stream !== null) {
    await ctx.db.delete(stream._id);
  }
}

export function pastDeadline(run: Pick<Doc<"runs">, "deadlineAt">, now: number): boolean {
  return run.deadlineAt !== undefined && now > run.deadlineAt;
}

export async function endRun(ctx: MutationCtx, runId: Id<"runs">, state: TerminalRunState): Promise<void> {
  await ctx.db.patch(runId, { state, endedAt: Date.now() });
  await deleteStream(ctx, runId);
}

// Every later model request replays this history, and a tool call with no result would make it malformed.
export async function closeUnansweredCalls(ctx: MutationCtx, run: Doc<"runs">): Promise<void> {
  const answered = new Set<string>();
  for await (const event of ctx.db
    .query("runEvents")
    .withIndex("by_run_seq", (q) => q.eq("runId", run._id))
    .order("desc")) {
    if (event.body.kind === "toolResult") {
      answered.add(event.body.toolCallId);
      continue;
    }
    if (event.body.kind !== "assistantTurn") {
      return;
    }
    let seq = run.nextSeq;
    for (const call of event.body.toolCalls.filter(({ id }) => !answered.has(id))) {
      await ctx.db.insert("runEvents", {
        runId: run._id,
        threadId: run.threadId,
        seq,
        body: {
          kind: "toolResult",
          toolCallId: call.id,
          name: call.name,
          outcome: "unavailable",
          output: UNANSWERED_CALL_OUTPUT,
          truncated: false,
        },
      });
      seq += 1;
    }
    await ctx.db.patch(run._id, { nextSeq: seq });
    return;
  }
}

export async function endPastDeadline(ctx: MutationCtx, run: Doc<"runs">): Promise<void> {
  await closeUnansweredCalls(ctx, run);
  await endRun(ctx, run._id, run.cancelRequested ? { kind: "cancelled" } : DEADLINE_FAILURE);
}

export function noRunnerHolds(run: Pick<Doc<"runs">, "state">, now: number): boolean {
  return run.state.kind === "queued" || (run.state.kind === "running" && run.state.leaseUntil < now);
}

export async function endRunsPastDeadline(ctx: MutationCtx, now: number): Promise<void> {
  for (const kind of ["queued", "running"] as const) {
    const late = await ctx.db
      .query("runs")
      .withIndex("by_state", (q) => q.eq("state.kind", kind))
      .filter((q) => q.and(q.neq(q.field("deadlineAt"), undefined), q.lt(q.field("deadlineAt"), now)))
      .take(LATE_RUNS_PER_TICK);
    for (const run of late) {
      if (noRunnerHolds(run, now)) {
        await endPastDeadline(ctx, run);
      }
    }
  }
}
