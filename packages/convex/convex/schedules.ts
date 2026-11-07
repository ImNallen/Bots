import { ConvexError } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { textProblem, type TextProblem } from "./memories.js";
import { describeCadence, nextFireAfter, parseCadence } from "./scheduleTime.js";
import { activeRunOfBot } from "./threads.js";
import type { RunEventBody, ScheduleCreate } from "./validators.js";

const RUN_LIMIT_MS = 30 * 60 * 1000;
const MAX_ROUTINES_PER_BOT = 10;
const MAX_ROUTINES_PER_OWNER = 20;
const MAX_INSTRUCTION_LENGTH = 2000;

export async function startReadOnlyRun(ctx: MutationCtx, schedule: Doc<"schedules">, deadlineAt = Date.now() + RUN_LIMIT_MS): Promise<Id<"runs">> {
  const { threadId, botId, ownerId } = schedule;
  if ((await activeRunOfBot(ctx, botId)) !== null) {
    throw new ConvexError("This bot already has an active run");
  }
  const runId = await ctx.db.insert("runs", {
    threadId,
    botId,
    ownerId,
    trigger: "schedule",
    capability: "readOnly",
    scheduleId: schedule._id,
    deadlineAt,
    state: { kind: "queued" },
    cancelRequested: false,
    nextSeq: 1,
  });
  await ctx.db.insert("runEvents", {
    runId,
    threadId,
    seq: 0,
    body: { kind: "scheduleFired", scheduleId: schedule._id, text: schedule.instruction },
  });
  return runId;
}

export const INSTRUCTION_PROBLEMS: Record<TextProblem | "empty", string> = {
  empty: "A routine needs an instruction, so nothing was created.",
  tooLong: `A routine's instruction cannot be longer than ${MAX_INSTRUCTION_LENGTH.toLocaleString("en-US")} characters, so nothing was created. Write a shorter one.`,
  characters: "A routine's instruction cannot hold control characters or characters that change the text's direction, so nothing was created. Write it without them.",
  secret: "This looks like a password, key, token, or card number, so nothing was created. Do not try again. A routine browses logged out, so it needs no login.",
};

export function instructionProblem(instruction: string): TextProblem | "empty" | null {
  return instruction === "" ? "empty" : textProblem(instruction, MAX_INSTRUCTION_LENGTH);
}

export async function applyScheduleCreate(ctx: MutationCtx, run: Doc<"runs">, call: ScheduleCreate): Promise<Extract<RunEventBody, { kind: "toolResult" }>> {
  const result = (outcome: "ok" | "error" | "cancelled" | "rejected", output: string) => ({
    kind: "toolResult" as const,
    toolCallId: call.toolCallId,
    name: "schedule_propose",
    outcome,
    output,
    truncated: false,
  });
  if (run.capability !== "full") {
    return result("rejected", "This run is read-only, so it cannot create a routine, and this call did not run.");
  }
  if (run.cancelRequested) {
    return result("cancelled", "The run was cancelled before this call created a routine, so it did not run.");
  }
  const approval = await ctx.db
    .query("approvals")
    .withIndex("by_run_call", (q) => q.eq("runId", run._id).eq("toolCallId", call.toolCallId))
    .unique();
  if (approval?.state !== "approved" || approval.toolName !== "schedule_propose") {
    return result("error", "Your owner did not approve this routine, so nothing was created.");
  }
  const timeZone = (await ctx.db.get(run.ownerId))?.timeZone;
  if (timeZone === undefined) {
    return result("error", "Your owner has no time zone set, so nothing was created. Ask them to set one in Settings, under General, and then to ask you again.");
  }
  const instruction = call.instruction.trim();
  const problem = instructionProblem(instruction);
  if (problem !== null) {
    return result("error", INSTRUCTION_PROBLEMS[problem]);
  }
  const cadence = parseCadence(call.cadence);
  if (cadence === null) {
    return result("error", "This schedule is not one a routine can have, so nothing was created. A weekly routine needs its weekdays, an hour, and a minute. An everyHours routine needs 1 to 24 whole hours.");
  }
  const ofOwner = await ctx.db
    .query("schedules")
    .withIndex("by_owner", (q) => q.eq("ownerId", run.ownerId))
    .collect();
  if (ofOwner.length >= MAX_ROUTINES_PER_OWNER) {
    return result("error", `Your owner already has ${MAX_ROUTINES_PER_OWNER} routines, so nothing was created. They can delete one in a bot's info panel.`);
  }
  if (ofOwner.filter((schedule) => schedule.botId === run.botId).length >= MAX_ROUTINES_PER_BOT) {
    return result("error", `You already have ${MAX_ROUTINES_PER_BOT} routines, so nothing was created. Your owner can delete one in your info panel.`);
  }
  const nextFireAt = nextFireAfter(cadence, timeZone, Date.now());
  const threadId = await ctx.db.insert("threads", { botId: run.botId, ownerId: run.ownerId, kind: "routine" });
  const scheduleId = await ctx.db.insert("schedules", { ownerId: run.ownerId, botId: run.botId, threadId, instruction, cadence, nextFireAt });
  return result(
    "ok",
    `Created routine ${scheduleId}. When: ${describeCadence(cadence, timeZone)}. First run: ${new Date(nextFireAt).toISOString()}. Your owner can pause, test, and delete it in your info panel.`,
  );
}
