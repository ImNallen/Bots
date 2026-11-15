import type { Id } from "@bots/convex/dataModel";
import { toolEffect, type ToolEffect, type ToolName } from "@bots/protocol";
import type { RunCapability } from "./run-logic.ts";

export type ApprovalLevel = "everything" | "outside" | "shell" | "nothing" | "automatic";
// byRules means the Automatic rules decide this call. The runner resolves it to run or ask through decideByRules. routineOnly refuses a
// call that only a routine can make.
export type ToolDecision = "run" | "ask" | "reject" | "byRules" | "routineOnly";

const POLL_MS = 2000;

type Ask = "ask" | "run" | "askAfterUntrustedText" | "byRules" | "routineOnly";

// One answer for each level and effect, so a new effect or level fails the typecheck until it has a row here.
const ASKS: Record<ApprovalLevel, Record<ToolEffect, Ask>> = {
  everything: { reads: "ask", readsScreen: "ask", changesVm: "ask", changesOutside: "ask", controlsComputer: "ask", changesMemory: "ask", changesSchedule: "ask", endsRoutine: "routineOnly" },
  outside: { reads: "run", readsScreen: "run", changesVm: "run", changesOutside: "ask", controlsComputer: "ask", changesMemory: "askAfterUntrustedText", changesSchedule: "askAfterUntrustedText", endsRoutine: "routineOnly" },
  shell: { reads: "run", readsScreen: "run", changesVm: "run", changesOutside: "run", controlsComputer: "ask", changesMemory: "run", changesSchedule: "askAfterUntrustedText", endsRoutine: "routineOnly" },
  // The owner asks for a routine change in chat, so it needs no card. A routine outlives the run and runs with nobody watching, so
  // once a page or a tool's output is in the run, a change could be an injection's, and it asks at every level.
  nothing: { reads: "run", readsScreen: "run", changesVm: "run", changesOutside: "run", controlsComputer: "run", changesMemory: "run", changesSchedule: "askAfterUntrustedText", endsRoutine: "routineOnly" },
  // The default. Reads run, the three effects that change things go to the rules, and a memory or routine write asks once untrusted
  // text is in.
  automatic: { reads: "run", readsScreen: "run", changesVm: "byRules", changesOutside: "byRules", controlsComputer: "byRules", changesMemory: "askAfterUntrustedText", changesSchedule: "askAfterUntrustedText", endsRoutine: "routineOnly" },
};

export const DENIED_OUTPUT = "The user denied this call, so it did not run.";
export const EXPIRED_OUTPUT = "The user did not answer in time, so this call did not run.";
export const NOT_SENT_CANCELLED_OUTPUT = "The run was cancelled while this call waited for approval, so it did not run.";
export const READ_ONLY_OUTPUT = "This run is read-only, so this call did not run. Do not try to reach the same result another way.";
export const FINAL_CALL_OUTPUT = "This run has reached its limit and had to write its report, so this call did not run.";
export const ROUTINE_ONLY_OUTPUT = "stay_quiet is only for routines, so this call did not run. Answer your owner in the chat.";

export function decideTool(args: {
  capability: RunCapability;
  level: ApprovalLevel;
  toolName: ToolName;
  readUntrustedText: boolean;
}): ToolDecision {
  switch (args.capability) {
    case "readOnly": {
      // readsScreen is not reads, so a routine never sees the logged-in desktop.
      const effect = toolEffect(args.toolName);
      return effect === "reads" || effect === "endsRoutine" ? "run" : "reject";
    }
    case "full": {
      const ask = ASKS[args.level][toolEffect(args.toolName)];
      if (ask === "byRules" || ask === "routineOnly") {
        return ask;
      }
      return ask === "ask" || (ask === "askAfterUntrustedText" && args.readUntrustedText) ? "ask" : "run";
    }
  }
}

export type Decision = "approved" | "denied" | "expired" | "aborted";

type ApprovalState = "pending" | "approved" | "denied" | "expired";
type Requested = { approvalId: Id<"approvals">; state: ApprovalState; expiresAt: number };

// Only an approved answer lets a call through. A failed read waits and asks again, so an outage can never run a call.
export async function waitForApproval(args: {
  request: () => Promise<Requested>;
  read: (approvalId: Id<"approvals">) => Promise<ApprovalState>;
  expire: (approvalId: Id<"approvals">) => Promise<unknown>;
  now: () => number;
  signals: AbortSignal[];
  onWait: () => void;
  pollMs?: number;
}): Promise<Decision> {
  const { request, read, expire, now, signals, onWait, pollMs = POLL_MS } = args;
  let requested: Requested | null = null;
  let state: ApprovalState = "pending";
  let waiting = false;
  for (;;) {
    if (signals.some((signal) => signal.aborted)) {
      return "aborted";
    }
    try {
      if (requested === null) {
        requested = await request();
        state = requested.state;
      } else {
        state = await read(requested.approvalId);
      }
    } catch {
      state = "pending";
    }
    if (state !== "pending") {
      return state;
    }
    if (requested !== null && now() >= requested.expiresAt) {
      await expire(requested.approvalId).catch(() => {});
      continue;
    }
    if (!waiting) {
      waiting = true;
      onWait();
    }
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        for (const signal of signals) {
          signal.removeEventListener("abort", finish);
        }
        resolve();
      };
      const timer = setTimeout(finish, pollMs);
      for (const signal of signals) {
        signal.addEventListener("abort", finish, { once: true });
      }
    });
  }
}
