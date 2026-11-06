import { isActive } from "./threads.js";
import type { RunEventBody, RunState } from "./validators.js";

export type BotActivity =
  | { kind: "idle" }
  | { kind: "queued" }
  | { kind: "running"; tool: string | null }
  | { kind: "needsApproval" }
  | { kind: "failed" };

const MAX_LAST_MESSAGE_LENGTH = 140;

// With no unanswered call in the newest turn, the bot is waiting on the model.
function runningTool(newestEvents: readonly RunEventBody[]): string | null {
  const answered = new Set<string>();
  for (const event of newestEvents) {
    if (event.kind === "toolResult") {
      answered.add(event.toolCallId);
    } else if (event.kind === "assistantTurn") {
      return event.toolCalls.find((call) => !answered.has(call.id))?.name ?? null;
    }
  }
  return null;
}

export function decideActivity(args: {
  hasPendingApproval: boolean;
  runState: RunState | null;
  newestEvents: readonly RunEventBody[];
}): BotActivity {
  const { hasPendingApproval, runState, newestEvents } = args;
  // An approval stays pending on a run that ended without an answer, and nobody can answer it any more.
  if (hasPendingApproval && runState !== null && isActive(runState)) {
    return { kind: "needsApproval" };
  }
  switch (runState?.kind) {
    case "running":
      return { kind: "running", tool: runningTool(newestEvents) };
    case "queued":
      return { kind: "queued" };
    case "failed":
      return { kind: "failed" };
    default:
      return { kind: "idle" };
  }
}

// Convex refuses a string with half of a surrogate pair, so a cut must not split an emoji.
function capMessage(text: string): string {
  const cut = text.slice(0, MAX_LAST_MESSAGE_LENGTH);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

export function lastMessageOf(newestEvents: readonly RunEventBody[]): string | null {
  for (const event of newestEvents) {
    if (event.kind !== "toolResult") {
      const text = event.text.replace(/\s+/g, " ").trim();
      if (text !== "") {
        return capMessage(text);
      }
    }
  }
  return null;
}
