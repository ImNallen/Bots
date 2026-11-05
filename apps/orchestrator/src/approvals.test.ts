import type { Id } from "@bots/convex/dataModel";
import { describe, expect, it } from "vitest";
import { needsApproval, waitForApproval, type ApprovalLevel } from "./approvals.ts";

const ID = "approval" as Id<"approvals">;
const TOOLS = ["shell", "read_file", "write_file", "browser_navigate", "browser_snapshot", "browser_click", "browser_type", "browser_press"];

describe("needsApproval", () => {
  const asked = (level: ApprovalLevel) => TOOLS.filter((toolName) => needsApproval({ level, toolName }));

  it("asks for every tool at everything", () => {
    expect(asked("everything")).toEqual(TOOLS);
  });

  it("asks for shell and for browser actions that change something at outside", () => {
    expect(asked("outside")).toEqual(["shell", "browser_click", "browser_type", "browser_press"]);
  });

  it("asks only for shell at shell", () => {
    expect(asked("shell")).toEqual(["shell"]);
  });

  it("asks for nothing at nothing", () => {
    expect(asked("nothing")).toEqual([]);
  });

  it("asks at outside for a tool it has never heard of", () => {
    expect(needsApproval({ level: "outside", toolName: "connector_send_email" })).toBe(true);
  });
});

function run(answers: Array<"pending" | "approved" | "denied" | "expired" | Error>, options: { signals?: AbortSignal[]; expiresAt?: number; now?: () => number } = {}) {
  const expired: string[] = [];
  const waits: number[] = [];
  let index = 0;
  const done = waitForApproval({
    request: async () => {
      const answer = answers[Math.min(index, answers.length - 1)];
      index += 1;
      if (answer instanceof Error) {
        throw answer;
      }
      return { approvalId: ID, state: answer ?? "pending", expiresAt: options.expiresAt ?? 10_000 };
    },
    expire: async (approvalId) => expired.push(approvalId),
    now: options.now ?? (() => 1000),
    signals: options.signals ?? [],
    onWait: () => waits.push(1),
    pollMs: 1,
  });
  return { done, expired, waits, asks: () => index };
}

describe("waitForApproval", () => {
  it("returns approved only after the answer arrives, and reports the wait once", async () => {
    const { done, waits } = run(["pending", "pending", "approved"]);
    expect(await done).toBe("approved");
    expect(waits).toEqual([1]);
  });

  it("returns denied", async () => {
    expect(await run(["pending", "denied"]).done).toBe("denied");
  });

  it("finds an answer that came before a restart without waiting", async () => {
    const { done, waits } = run(["approved"]);
    expect(await done).toBe("approved");
    expect(waits).toEqual([]);
  });

  it("does not let a call through while the state cannot be read", async () => {
    const { done, asks } = run([new Error("convex is down"), new Error("convex is down"), new Error("convex is down"), "approved"]);
    expect(await done).toBe("approved");
    expect(asks()).toBe(4);
  });

  it("never treats a failed read as an answer", async () => {
    const cancel = new AbortController();
    const { done } = run([new Error("convex is down")], { signals: [cancel.signal] });
    setTimeout(() => cancel.abort(), 10);
    expect(await done).toBe("aborted");
  });

  it("returns aborted when the run is cancelled during the wait", async () => {
    const cancel = new AbortController();
    const { done } = run(["pending"], { signals: [cancel.signal] });
    setTimeout(() => cancel.abort(), 5);
    expect(await done).toBe("aborted");
  });

  it("expires a request nobody answered, and reports it as expired", async () => {
    const answers: Array<"pending" | "expired"> = ["pending", "expired"];
    const { done, expired } = run(answers, { expiresAt: 500, now: () => 1000 });
    expect(await done).toBe("expired");
    expect(expired).toEqual([ID]);
  });

  it("does not ask when the run is already cancelled", async () => {
    const cancel = new AbortController();
    cancel.abort();
    const { done, asks } = run(["approved"], { signals: [cancel.signal] });
    expect(await done).toBe("aborted");
    expect(asks()).toBe(0);
  });
});
