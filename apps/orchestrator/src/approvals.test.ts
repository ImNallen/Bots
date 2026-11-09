import type { Id } from "@bots/convex/dataModel";
import type { ToolName } from "@bots/protocol";
import { describe, expect, it } from "vitest";
import { decideTool, waitForApproval, type ApprovalLevel } from "./approvals.ts";

const ID = "approval" as Id<"approvals">;
const LEVELS: ApprovalLevel[] = ["everything", "outside", "shell", "nothing"];
const ANSWERS: Record<ToolName, Record<ApprovalLevel, boolean>> = {
  shell: { everything: true, outside: true, shell: true, nothing: false },
  read_file: { everything: true, outside: false, shell: false, nothing: false },
  write_file: { everything: true, outside: false, shell: false, nothing: false },
  web_fetch: { everything: true, outside: false, shell: false, nothing: false },
  web_search: { everything: true, outside: false, shell: false, nothing: false },
  browser_navigate: { everything: true, outside: false, shell: false, nothing: false },
  browser_snapshot: { everything: true, outside: false, shell: false, nothing: false },
  browser_click: { everything: true, outside: true, shell: false, nothing: false },
  browser_type: { everything: true, outside: true, shell: false, nothing: false },
  browser_press: { everything: true, outside: true, shell: false, nothing: false },
  desktop_look: { everything: true, outside: false, shell: false, nothing: false },
  desktop_click: { everything: true, outside: true, shell: true, nothing: false },
  desktop_type: { everything: true, outside: true, shell: true, nothing: false },
  desktop_key: { everything: true, outside: true, shell: true, nothing: false },
  desktop_scroll: { everything: true, outside: true, shell: true, nothing: false },
  memory_save: { everything: true, outside: false, shell: false, nothing: false },
  memory_forget: { everything: true, outside: false, shell: false, nothing: false },
  description_set: { everything: true, outside: false, shell: false, nothing: false },
  schedule_propose: { everything: true, outside: true, shell: true, nothing: true },
};
const TOOLS = Object.keys(ANSWERS) as ToolName[];
const MEMORY_TOOLS: ToolName[] = ["memory_save", "memory_forget", "description_set"];

const READS: ToolName[] = ["read_file", "web_fetch", "web_search", "browser_navigate", "browser_snapshot"];

describe("decideTool for a read-only run", () => {
  it.each(LEVELS.flatMap((level) => TOOLS.flatMap((toolName) => [false, true].map((readUntrustedText) => ({ level, toolName, readUntrustedText })))))(
    "at $level, $toolName with readUntrustedText $readUntrustedText never asks, and runs only what reads",
    (args) => {
      expect(decideTool({ capability: "readOnly", ...args })).toBe(READS.includes(args.toolName) ? "run" : "reject");
    },
  );

  it("forbids exactly the tools that change something, and every desktop tool, because the desktop shows the owner's logins", () => {
    const rejected = TOOLS.filter((toolName) => decideTool({ capability: "readOnly", level: "nothing", toolName, readUntrustedText: false }) === "reject");
    expect(rejected).toEqual(["shell", "write_file", "browser_click", "browser_type", "browser_press", "desktop_look", "desktop_click", "desktop_type", "desktop_key", "desktop_scroll", "memory_save", "memory_forget", "description_set", "schedule_propose"]);
  });
});

describe("decideTool for a full run", () => {
  const needsApproval = (args: { level: ApprovalLevel; toolName: ToolName; readUntrustedText: boolean }) => {
    const decision = decideTool({ capability: "full", ...args });
    expect(decision).not.toBe("reject");
    return decision === "ask";
  };
  const asked = (level: ApprovalLevel, readUntrustedText = false) =>
    TOOLS.filter((toolName) => needsApproval({ level, toolName, readUntrustedText }));

  it.each(TOOLS)("gives the expected answer at every level for %s, before the run reads untrusted text", (toolName) => {
    const answers = Object.fromEntries(LEVELS.map((level) => [level, needsApproval({ level, toolName, readUntrustedText: false })]));
    expect(answers).toEqual(ANSWERS[toolName]);
  });

  it.each(TOOLS.filter((toolName) => !MEMORY_TOOLS.includes(toolName)))(
    "gives %s the same answers after the run reads untrusted text",
    (toolName) => {
      const answers = Object.fromEntries(LEVELS.map((level) => [level, needsApproval({ level, toolName, readUntrustedText: true })]));
      expect(answers).toEqual(ANSWERS[toolName]);
    },
  );

  it.each(MEMORY_TOOLS)("asks for %s at outside only after the run reads untrusted text", (toolName) => {
    expect(needsApproval({ level: "outside", toolName, readUntrustedText: false })).toBe(false);
    expect(needsApproval({ level: "outside", toolName, readUntrustedText: true })).toBe(true);
  });

  it.each(MEMORY_TOOLS)("gives %s the same answer at the other levels, whatever the run has touched", (toolName) => {
    for (const readUntrustedText of [false, true]) {
      expect(needsApproval({ level: "everything", toolName, readUntrustedText })).toBe(true);
      expect(needsApproval({ level: "shell", toolName, readUntrustedText })).toBe(false);
      expect(needsApproval({ level: "nothing", toolName, readUntrustedText })).toBe(false);
    }
  });

  it("asks for every tool at everything", () => {
    expect(asked("everything")).toEqual(TOOLS);
  });

  const DESKTOP_INPUT: ToolName[] = ["desktop_click", "desktop_type", "desktop_key", "desktop_scroll"];

  it("asks for shell, desktop input, and browser actions that change something at outside", () => {
    expect(asked("outside")).toEqual(["shell", "browser_click", "browser_type", "browser_press", ...DESKTOP_INPUT, "schedule_propose"]);
  });

  it("also asks for the memory tools at outside after the run reads untrusted text", () => {
    expect(asked("outside", true)).toEqual(["shell", "browser_click", "browser_type", "browser_press", ...DESKTOP_INPUT, "memory_save", "memory_forget", "description_set", "schedule_propose"]);
  });

  it("asks for anything that can run a program, and a routine, at shell, because a terminal is one click away", () => {
    expect(asked("shell")).toEqual(["shell", ...DESKTOP_INPUT, "schedule_propose"]);
    expect(asked("shell", true)).toEqual(["shell", ...DESKTOP_INPUT, "schedule_propose"]);
  });

  it("asks only for a routine at nothing", () => {
    expect(asked("nothing")).toEqual(["schedule_propose"]);
    expect(asked("nothing", true)).toEqual(["schedule_propose"]);
  });
});

function run(answers: Array<"pending" | "approved" | "denied" | "expired" | Error>, options: { signals?: AbortSignal[]; expiresAt?: number; now?: () => number } = {}) {
  const expired: string[] = [];
  const waits: number[] = [];
  let index = 0;
  let requests = 0;
  const next = () => {
    const answer = answers[Math.min(index, answers.length - 1)];
    index += 1;
    if (answer instanceof Error) {
      throw answer;
    }
    return answer ?? "pending";
  };
  const done = waitForApproval({
    request: async () => {
      requests += 1;
      return { approvalId: ID, state: next(), expiresAt: options.expiresAt ?? 10_000 };
    },
    read: async () => next(),
    expire: async (approvalId) => expired.push(approvalId),
    now: options.now ?? (() => 1000),
    signals: options.signals ?? [],
    onWait: () => waits.push(1),
    pollMs: 1,
  });
  return { done, expired, waits, asks: () => index, requests: () => requests };
}

describe("waitForApproval", () => {
  it("returns approved only after the answer arrives, and reports the wait once", async () => {
    const { done, waits } = run(["pending", "pending", "approved"]);
    expect(await done).toBe("approved");
    expect(waits).toEqual([1]);
  });

  it("creates the request once, and only reads after that", async () => {
    const { done, requests, asks } = run(["pending", "pending", "pending", "approved"]);
    expect(await done).toBe("approved");
    expect(requests()).toBe(1);
    expect(asks()).toBe(4);
  });

  it("asks again until the request exists", async () => {
    const { done, requests } = run([new Error("convex is down"), "approved"]);
    expect(await done).toBe("approved");
    expect(requests()).toBe(2);
  });

  it("keeps waiting when a read fails after the request exists", async () => {
    const { done, asks } = run(["pending", new Error("convex is down"), new Error("convex is down"), "denied"]);
    expect(await done).toBe("denied");
    expect(asks()).toBe(4);
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
