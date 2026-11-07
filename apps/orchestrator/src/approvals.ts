import type { Doc, Id } from "@bots/convex/dataModel";
import { toolEffect, type ToolEffect, type ToolName } from "@bots/protocol";

export type ApprovalLevel = "everything" | "outside" | "shell" | "nothing";
export type RunCapability = Doc<"runs">["capability"];
export type ToolDecision = "run" | "ask" | "reject";

const POLL_MS = 2000;

const ASKS_AT_OUTSIDE: Record<ToolEffect, (touchedComputer: boolean) => boolean> = {
  reads: () => false,
  changesVm: () => false,
  changesOutside: () => true,
  changesMemory: (touchedComputer) => touchedComputer,
};

export const DENIED_OUTPUT = "The user denied this call, so it did not run.";
export const EXPIRED_OUTPUT = "The user did not answer in time, so this call did not run.";
export const NOT_SENT_CANCELLED_OUTPUT = "The run was cancelled while this call waited for approval, so it did not run.";
export const READ_ONLY_OUTPUT = "This run is read-only, so this call did not run. Do not try to reach the same result another way.";

function needsApproval(args: { level: ApprovalLevel; toolName: ToolName; touchedComputer: boolean }): boolean {
  switch (args.level) {
    case "everything":
      return true;
    case "outside":
      return ASKS_AT_OUTSIDE[toolEffect(args.toolName)](args.touchedComputer);
    case "shell":
      return args.toolName === "shell";
    case "nothing":
      return false;
  }
}

// A read-only run has nobody to ask, so its answer does not depend on the level.
export function decideTool(args: {
  capability: RunCapability;
  level: ApprovalLevel;
  toolName: ToolName;
  touchedComputer: boolean;
}): ToolDecision {
  switch (args.capability) {
    case "readOnly":
      return toolEffect(args.toolName) === "reads" ? "run" : "reject";
    case "full":
      return needsApproval(args) ? "ask" : "run";
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
