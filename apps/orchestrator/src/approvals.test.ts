import type { Id } from "@bots/convex/dataModel";
import type { ToolName } from "@bots/protocol";
import { describe, expect, it } from "vitest";
import { decideTool, waitForApproval, type ApprovalLevel } from "./approvals.ts";
import { readUntrustedText, type RunEventBody } from "./run-logic.ts";

const ID = "approval" as Id<"approvals">;
// The levels whose answer is a plain run-or-ask. Automatic sends the three changing effects to the rules, so it has its own test.
const LEVELS = ["everything", "outside", "shell", "nothing"] as const satisfies readonly ApprovalLevel[];
const ALL_LEVELS: readonly ApprovalLevel[] = [...LEVELS, "automatic"];
const ANSWERS: Record<ToolName, Record<(typeof LEVELS)[number], boolean>> = {
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
  schedule_create: { everything: true, outside: false, shell: false, nothing: false },
  schedule_update: { everything: true, outside: false, shell: false, nothing: false },
  schedule_delete: { everything: true, outside: false, shell: false, nothing: false },
  stay_quiet: { everything: false, outside: false, shell: false, nothing: false },
};
const TOOLS = Object.keys(ANSWERS) as ToolName[];
const SCHEDULE_TOOLS: ToolName[] = ["schedule_create", "schedule_update", "schedule_delete"];
// A memory or routine write asks once the run has read text that anyone could have written.
const MEMORY_TOOLS: ToolName[] = ["memory_save", "memory_forget", "description_set", ...SCHEDULE_TOOLS];

const READS: ToolName[] = ["read_file", "web_fetch", "web_search", "browser_navigate", "browser_snapshot"];
const RUNS_READ_ONLY: ToolName[] = [...READS, "stay_quiet"];

describe("decideTool for a read-only run", () => {
  it.each(ALL_LEVELS.flatMap((level) => TOOLS.flatMap((toolName) => [false, true].map((readUntrustedText) => ({ level, toolName, readUntrustedText })))))(
    "at $level, $toolName with readUntrustedText $readUntrustedText never asks, and runs only what reads and stay_quiet",
    (args) => {
      expect(decideTool({ capability: "readOnly", ...args })).toBe(RUNS_READ_ONLY.includes(args.toolName) ? "run" : "reject");
    },
  );

  it("forbids exactly the tools that change something, and every desktop tool, because the desktop shows the owner's logins", () => {
    const rejected = TOOLS.filter((toolName) => decideTool({ capability: "readOnly", level: "nothing", toolName, readUntrustedText: false }) === "reject");
    expect(rejected).toEqual(["shell", "write_file", "browser_click", "browser_type", "browser_press", "desktop_look", "desktop_click", "desktop_type", "desktop_key", "desktop_scroll", "memory_save", "memory_forget", "description_set", ...SCHEDULE_TOOLS]);
  });
});

describe("decideTool for stay_quiet in a full run", () => {
  it.each(ALL_LEVELS.flatMap((level) => [false, true].map((readUntrustedText) => ({ level, readUntrustedText }))))(
    "at $level with readUntrustedText $readUntrustedText refuses it as routine-only, and does not call the run read-only",
    (args) => {
      expect(decideTool({ capability: "full", toolName: "stay_quiet", ...args })).toBe("routineOnly");
    },
  );
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

  it.each(MEMORY_TOOLS.filter((toolName) => !SCHEDULE_TOOLS.includes(toolName)))("gives %s the same answer at the other levels, whatever the run has touched", (toolName) => {
    for (const readUntrustedText of [false, true]) {
      expect(needsApproval({ level: "everything", toolName, readUntrustedText })).toBe(true);
      expect(needsApproval({ level: "shell", toolName, readUntrustedText })).toBe(false);
      expect(needsApproval({ level: "nothing", toolName, readUntrustedText })).toBe(false);
    }
  });

  it("asks for a memory save at outside once a search has a result, though the search ran outside the computer", () => {
    const searched: RunEventBody[] = [
      { kind: "userMessage", text: "find it and remember it" },
      { kind: "toolResult", toolCallId: "a", name: "web_search", outcome: "ok", output: 'Results for "it":', truncated: false },
    ];
    const save = (events: RunEventBody[]) =>
      decideTool({ capability: "full", level: "outside", toolName: "memory_save", readUntrustedText: readUntrustedText(events) });
    expect(save(searched.slice(0, 1))).toBe("run");
    expect(save(searched)).toBe("ask");
  });

  it("asks for every tool at everything, but stay_quiet, which a full run refuses", () => {
    expect(asked("everything")).toEqual(TOOLS.filter((toolName) => toolName !== "stay_quiet"));
  });

  const DESKTOP_INPUT: ToolName[] = ["desktop_click", "desktop_type", "desktop_key", "desktop_scroll"];

  it("asks for shell, desktop input, and browser actions that change something at outside", () => {
    expect(asked("outside")).toEqual(["shell", "browser_click", "browser_type", "browser_press", ...DESKTOP_INPUT]);
  });

  it("also asks for the memory tools at outside after the run reads untrusted text", () => {
    expect(asked("outside", true)).toEqual(["shell", "browser_click", "browser_type", "browser_press", ...DESKTOP_INPUT, "memory_save", "memory_forget", "description_set", ...SCHEDULE_TOOLS]);
  });

  it("asks for anything that can run a program at shell, because a terminal is one click away, and for a routine after untrusted text", () => {
    expect(asked("shell")).toEqual(["shell", ...DESKTOP_INPUT]);
    expect(asked("shell", true)).toEqual(["shell", ...DESKTOP_INPUT, ...SCHEDULE_TOOLS]);
  });

  it("asks for nothing at nothing until the run reads untrusted text, and then only for a routine, because a routine outlives the run", () => {
    expect(asked("nothing")).toEqual([]);
    expect(asked("nothing", true)).toEqual(SCHEDULE_TOOLS);
  });
});

describe("decideTool at the automatic level", () => {
  const at = (toolName: ToolName, readUntrustedText = false) => decideTool({ capability: "full", level: "automatic", toolName, readUntrustedText });

  it.each(READS)("runs %s with no card", (toolName) => {
    expect(at(toolName)).toBe("run");
  });

  it("runs a look with no card", () => {
    expect(at("desktop_look")).toBe("run");
  });

  it.each<ToolName>(["write_file", "shell", "browser_click", "browser_type", "browser_press", "desktop_click", "desktop_type", "desktop_key", "desktop_scroll"])(
    "sends %s to the rules",
    (toolName) => {
      expect(at(toolName)).toBe("byRules");
    },
  );

  it.each(MEMORY_TOOLS)("runs %s until the run reads untrusted text, then asks", (toolName) => {
    expect(at(toolName, false)).toBe("run");
    expect(at(toolName, true)).toBe("ask");
  });

  it.each(SCHEDULE_TOOLS)("runs %s until the run reads untrusted text, then asks", (toolName) => {
    expect(at(toolName, false)).toBe("run");
    expect(at(toolName, true)).toBe("ask");
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
