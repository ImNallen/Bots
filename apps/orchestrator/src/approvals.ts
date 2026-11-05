import type { Id } from "@bots/convex/dataModel";

export type ApprovalLevel = "everything" | "outside" | "shell" | "nothing";

const POLL_MS = 1000;

// These change nothing outside the VM. Any other tool asks, so a tool added later cannot run unasked by being forgotten here.
const FREE_AT_OUTSIDE_LEVEL = new Set(["read_file", "write_file", "browser_navigate", "browser_snapshot"]);

export const DENIED_OUTPUT = "The user denied this call, so it did not run.";
export const EXPIRED_OUTPUT = "The user did not answer in time, so this call did not run.";
export const NOT_SENT_CANCELLED_OUTPUT = "The run was cancelled while this call waited for approval, so it did not run.";

export function needsApproval(args: { level: ApprovalLevel; toolName: string }): boolean {
  switch (args.level) {
    case "everything":
      return true;
    case "outside":
      return !FREE_AT_OUTSIDE_LEVEL.has(args.toolName);
    case "shell":
      return args.toolName === "shell";
    case "nothing":
      return false;
  }
}

export type Decision = "approved" | "denied" | "expired" | "aborted";

type Requested = { approvalId: Id<"approvals">; state: "pending" | "approved" | "denied" | "expired"; expiresAt: number };

// Only an approved answer lets a call through. A failed read waits and asks again, so an outage can never run a call.
export async function waitForApproval(args: {
  request: () => Promise<Requested>;
  expire: (approvalId: Id<"approvals">) => Promise<unknown>;
  now: () => number;
  signals: AbortSignal[];
  onWait: () => void;
  pollMs?: number;
}): Promise<Decision> {
  const { request, expire, now, signals, onWait, pollMs = POLL_MS } = args;
  let waiting = false;
  for (;;) {
    if (signals.some((signal) => signal.aborted)) {
      return "aborted";
    }
    let answer: Requested | null = null;
    try {
      answer = await request();
    } catch {
      answer = null;
    }
    if (answer !== null && answer.state !== "pending") {
      return answer.state;
    }
    if (answer !== null && now() >= answer.expiresAt) {
      await expire(answer.approvalId).catch(() => {});
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
