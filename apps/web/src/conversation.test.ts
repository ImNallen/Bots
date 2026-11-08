import type { Id } from "@bots/convex/dataModel";
import { describe, expect, it } from "vitest";
import { conversationItems, timeLabel, type DisplayItem, type PendingApproval, type Timeline } from "./conversation.ts";

type Run = Timeline["runs"][number];
type Event = Run["events"][number];
type Body = Event["body"];

const NOW = new Date(2026, 10, 6, 15, 0).getTime();
const USAGE = { promptTokens: 1, completionTokens: 1 };

function id<T extends "runs" | "runEvents" | "approvals">(value: string): Id<T> {
  return value as Id<T>;
}

function run(overrides: Partial<Run> & { bodies?: Body[] } = {}): Run {
  const { bodies = [], ...rest } = overrides;
  const _id = rest._id ?? id<"runs">("run1");
  return {
    _id,
    createdAt: NOW,
    state: { kind: "done" },
    cancelRequested: false,
    stream: null,
    events: bodies.map((body, seq) => ({ _id: id<"runEvents">(`${_id}-e${seq}`), seq, body })),
    ...rest,
  };
}

function turn(text: string, calls: { id: string; name: string; arguments: string }[] = [], reasoning?: string): Body {
  return { kind: "assistantTurn", text, reasoning, toolCalls: calls, usage: USAGE, model: "m" };
}

function result(toolCallId: string, outcome: Extract<Body, { kind: "toolResult" }>["outcome"], output = "out"): Body {
  return { kind: "toolResult", toolCallId, name: "shell", outcome, output, truncated: false };
}

const shell = (command: string, callId = "c1") => ({ id: callId, name: "shell", arguments: JSON.stringify({ command }) });

function itemsOf(runs: Run[], pending: PendingApproval[] = [], omittedOlder = false): DisplayItem[] {
  return conversationItems({ timeline: { runs, omittedOlder }, pending, now: NOW, locale: "en-US", timeZone: "Europe/Stockholm" });
}

function only<K extends DisplayItem["kind"]>(items: DisplayItem[], kind: K): Extract<DisplayItem, { kind: K }> {
  const matches = items.filter((item) => item.kind === kind);
  expect(matches).toHaveLength(1);
  return matches[0] as Extract<DisplayItem, { kind: K }>;
}

const kinds = (items: DisplayItem[]) => items.map((item) => item.kind);
const approval = (toolCallId = "c1", subject: string | null = null): PendingApproval => ({
  _id: id<"approvals">("a1"),
  runId: id<"runs">("run1"),
  toolCallId,
  subject,
});

describe("conversationItems", () => {
  it("flattens a finished run in reading order", () => {
    const items = itemsOf([
      run({
        bodies: [
          { kind: "userMessage", text: "Hi **there**" },
          turn("Let me look.", [shell("ls")], "I should list files."),
          result("c1", "ok", "a.txt"),
          turn("Found it."),
        ],
      }),
    ]);
    expect(kinds(items)).toEqual(["time", "user", "assistant", "tool", "assistant"]);
    expect(only(items, "user").text).toBe("Hi **there**");
    expect(JSON.stringify(items)).not.toContain("I should list files.");
  });

  describe("a routine's report", () => {
    const report: Body = { kind: "routineReport", scheduleId: "s" as Id<"schedules">, runId: id<"runs">("raw"), text: "Version **2** shipped." };

    it("is its own item, keeping its markdown", () => {
      const items = itemsOf([run({ bodies: [report] })]);
      expect(kinds(items)).toEqual(["time", "report"]);
      expect(only(items, "report").text).toBe("Version **2** shipped.");
    });

    it("sits between the owner's messages in order, with no status line", () => {
      const items = itemsOf([
        run({ _id: id<"runs">("a"), bodies: [{ kind: "userMessage", text: "before" }, turn("reply")] }),
        run({ _id: id<"runs">("b"), bodies: [report] }),
        run({ _id: id<"runs">("c"), bodies: [{ kind: "userMessage", text: "after" }, turn("reply")] }),
      ]);
      expect(kinds(items)).toEqual(["time", "user", "assistant", "report", "user", "assistant"]);
    });

    it("gives a routine's instruction no item, because the chat shows only its report", () => {
      const fired: Body = { kind: "scheduleFired", scheduleId: "s" as Id<"schedules">, text: "Check the news." };
      expect(kinds(itemsOf([run({ bodies: [fired] })]))).toEqual(["time"]);
    });
  });

  it("leaves out a turn with no words", () => {
    const items = itemsOf([run({ bodies: [turn("  \n", [shell("ls")]), result("c1", "ok")] })]);
    expect(kinds(items)).toEqual(["time", "tool"]);
  });

  describe("a routine's card", () => {
    const propose = (args: unknown) => ({ id: "c1", name: "schedule_propose", arguments: JSON.stringify(args) });
    const card = (args: unknown) => only(itemsOf([run({ state: { kind: "running" }, bodies: [turn("", [propose(args)])] })], [approval()]), "approval");

    it("takes its title from the schedule and the owner's zone, and shows the instruction in full", () => {
      const instruction = `Read the news.\n${"And the weather. ".repeat(100)}`;
      expect(card({ instruction, cadence: { kind: "weekly", weekdays: [1, 4], hour: 9, minute: 0 } })).toMatchObject({
        title: "Create this routine? Every Monday and Thursday at 09:00, Europe/Stockholm time.",
        arguments: [{ label: null, value: instruction }],
      });
    });

    it("says how often for a routine with no wall time", () => {
      expect(card({ instruction: "x", cadence: { kind: "everyHours", hours: 6 } }).title).toBe("Create this routine? Every 6 hours.");
    });

    it("shows what the call said if a card ever holds a schedule the rule refuses", () => {
      const args = { instruction: "x", cadence: { kind: "everyHours", hours: 0 } };
      expect(card(args)).toMatchObject({ title: "Create this routine?", arguments: [{ label: "instruction", value: "x" }, { label: "cadence" }] });
    });

    it("words its row once it is done", () => {
      const body = result("c1", "ok", "Created routine r1.");
      const row = only(itemsOf([run({ bodies: [turn("", [propose({ instruction: "Read the news.", cadence: { kind: "everyHours", hours: 6 } })]), body] })]), "tool");
      expect(row).toMatchObject({ name: "Created a routine", summary: "Read the news.", status: "finished" });
    });
  });

  describe("tool rows", () => {
    const row = (name: string, args: unknown, bodyResult: Body = result("c1", "ok")) =>
      only(itemsOf([run({ bodies: [turn("", [{ id: "c1", name, arguments: JSON.stringify(args) }]), bodyResult] })]), "tool");

    it.each([
      ["shell", "Ran a command"],
      ["read_file", "Read a file"],
      ["write_file", "Saved a file"],
      ["browser_navigate", "Opened a page"],
      ["browser_snapshot", "Read the page"],
      ["browser_click", "Clicked on the page"],
      ["browser_type", "Typed on the page"],
      ["browser_press", "Pressed a key"],
      ["desktop_look", "Looked at the screen"],
      ["desktop_click", "Clicked on the screen"],
      ["desktop_type", "Typed on the screen"],
      ["desktop_key", "Pressed keys"],
      ["desktop_scroll", "Scrolled the screen"],
      ["memory_save", "Saved a note"],
      ["memory_forget", "Forgot a note"],
      ["description_set", "Updated its description"],
    ])("words %s in plain language", (name, words) => {
      expect(row(name, {}).name).toBe(words);
    });

    it("shows a saved note's text in its row, so every save is visible in the chat", () => {
      expect(row("memory_save", { text: "Out on Fridays." }).summary).toBe("Out on Fridays.");
    });

    it("shows a description's new text in its row, so every change is visible in the chat", () => {
      expect(row("description_set", { text: "A scout for release notes." }).summary).toBe("A scout for release notes.");
    });

    it("shows a save that the rules refused as failed, with the reason in its output", () => {
      const refused = row("memory_save", { text: "password=hunter2" }, result("c1", "error", "This looks like a password."));
      expect(refused).toMatchObject({ status: "failed", note: "failed", output: { text: "This looks like a password." } });
    });

    it("shows the raw name of an unknown tool, including one named like an object's property", () => {
      expect(row("a_new_tool", {}).name).toBe("a_new_tool");
      expect(row("constructor", {}).name).toBe("constructor");
    });

    it("summarises a call by its first string argument", () => {
      expect(row("shell", { timeoutSeconds: 5, command: "ls -la" }).summary).toBe("ls -la");
      expect(row("browser_snapshot", {}).summary).toBe("");
      expect(row("browser_click", { ref: 5 }).summary).toBe('{"ref":5}');
    });

    it("shows a malformed call as it arrived", () => {
      const items = itemsOf([run({ bodies: [turn("", [{ id: "c1", name: "shell", arguments: "{oops" }]), result("c1", "invalid")] })]);
      expect(only(items, "tool").summary).toBe("{oops");
    });

    it("carries the output, exit code, and truncation", () => {
      const body: Body = { kind: "toolResult", toolCallId: "c1", name: "shell", outcome: "ok", output: "hi", exitCode: 0, truncated: true };
      expect(row("shell", {}, body).output).toEqual({ text: "hi", exitCode: 0, truncated: true });
    });

    it("says a rejected call was blocked because the run is read-only", () => {
      const rejected = row("shell", { command: "rm -rf /" }, result("c1", "rejected", "This run is read-only."));
      expect(rejected).toMatchObject({ status: "failed", note: "blocked, read-only run", summary: "rm -rf /", output: { text: "This run is read-only." } });
    });

    it.each(["error", "timeout", "interrupted", "unavailable", "invalid"] as const)("marks outcome %s as failed", (outcome) => {
      const failed = row("shell", {}, result("c1", outcome));
      expect(failed.status).toBe("failed");
      expect(failed.note).not.toBeNull();
    });

    it.each(["ok", "cancelled"] as const)("does not mark outcome %s as failed", (outcome) => {
      expect(row("shell", {}, result("c1", outcome)).status).toBe("finished");
    });

    it("words a call in the present tense while it runs and has no output yet", () => {
      const running = only(itemsOf([run({ state: { kind: "running" }, bodies: [turn("", [shell("sleep 9")])] })]), "tool");
      expect(running).toMatchObject({ name: "Running a command", status: "running", output: null });
    });

    it("says a call in a run that ended has no result", () => {
      const ended = only(itemsOf([run({ state: { kind: "failed", reason: "x" }, bodies: [turn("", [shell("ls")])] })]), "tool");
      expect(ended).toMatchObject({ name: "Ran a command", status: "finished", note: "no result", output: null });
    });
  });

  describe("approvals", () => {
    const pendingRun = (call = shell("ls")) => run({ state: { kind: "running" }, bodies: [turn("", [call])] });

    it("turns a pending call into a question with its full arguments and no status line", () => {
      const items = itemsOf([pendingRun(shell("printf 'a\nb'"))], [approval()]);
      expect(kinds(items)).toEqual(["time", "approval"]);
      expect(only(items, "approval")).toMatchObject({
        approvalId: "a1",
        title: "Run this command?",
        arguments: [{ label: null, value: "printf 'a\nb'" }],
      });
    });

    it("asks about a desktop input in the orchestrator's words, shows typed text in full, and shows the screen", () => {
      const askOf = (name: string, args: object, subject: string) =>
        only(itemsOf([pendingRun({ id: "c1", name, arguments: JSON.stringify(args) })], [approval("c1", subject)]), "approval");
      expect(askOf("desktop_click", { mark: 4 }, 'Click entry "Address and search bar" in Chromium')).toEqual({
        key: "run1:c1",
        kind: "approval",
        approvalId: "a1",
        title: "Click this?",
        arguments: [{ label: null, value: 'Click entry "Address and search bar" in Chromium' }],
        picture: true,
      });
      expect(askOf("desktop_type", { mark: 4, text: "rm -rf ~\nexit", submit: true }, 'Type into entry "x" in Chromium, then press Enter')).toMatchObject({
        title: "Type this?",
        arguments: [
          { label: null, value: 'Type into entry "x" in Chromium, then press Enter' },
          { label: "text", value: "rm -rf ~\nexit" },
        ],
        picture: true,
      });
      expect(only(itemsOf([pendingRun()], [approval()]), "approval").picture).toBe(false);
    });

    it("asks about a save with the exact text, and about a forget with its id", () => {
      const askOf = (name: string, args: object) =>
        only(itemsOf([pendingRun({ id: "c1", name, arguments: JSON.stringify(args) })], [approval()]), "approval");
      expect(askOf("memory_save", { text: "Out\non Fridays." })).toMatchObject({
        title: "Save this note?",
        arguments: [{ label: null, value: "Out\non Fridays." }],
      });
      expect(askOf("memory_forget", { id: "note1" })).toMatchObject({
        title: "Forget this note?",
        arguments: [{ label: null, value: "note1" }],
      });
      expect(askOf("description_set", { text: "A scout.\nIt reads notes." })).toMatchObject({
        title: "Update this description?",
        arguments: [{ label: null, value: "A scout.\nIt reads notes." }],
      });
    });

    it("keeps each argument apart and keeps a string's line breaks", () => {
      const call = { id: "c1", name: "write_file", arguments: JSON.stringify({ path: "a.md", content: "one\ntwo", mode: { x: 1 } }) };
      expect(only(itemsOf([pendingRun(call)], [approval()]), "approval").arguments).toEqual([
        { label: "path", value: "a.md" },
        { label: "content", value: "one\ntwo" },
        { label: "mode", value: '{\n  "x": 1\n}' },
      ]);
    });

    it("shows malformed arguments as they arrived", () => {
      const call = { id: "c1", name: "shell", arguments: "not json" };
      expect(only(itemsOf([pendingRun(call)], [approval()]), "approval").arguments).toEqual([{ label: null, value: "not json" }]);
    });

    it("asks about an unknown tool by its raw name", () => {
      const call = { id: "c1", name: "a_new_tool", arguments: "{}" };
      expect(only(itemsOf([pendingRun(call)], [approval()]), "approval").title).toBe("Run a_new_tool?");
    });

    it("becomes a running row once it is answered", () => {
      const items = itemsOf([pendingRun()]);
      expect(kinds(items)).toEqual(["time", "tool", "status"]);
      expect(only(items, "tool").status).toBe("running");
    });

    it("prefers a stored result over a pending row", () => {
      const items = itemsOf([run({ bodies: [turn("", [shell("ls")]), result("c1", "ok")] })], [approval()]);
      expect(kinds(items)).toEqual(["time", "tool"]);
    });

    it("does not match an approval from another run", () => {
      const other: PendingApproval = { ...approval(), runId: id<"runs">("run2") };
      expect(kinds(itemsOf([pendingRun()], [other]))).toEqual(["time", "tool", "status"]);
    });

    it("shows a refusal's own words, so an expired approval can say so", () => {
      const text = "The user did not answer in time, so this call did not run.";
      const items = itemsOf([run({ bodies: [turn("", [shell("ls")]), result("c1", "denied", text)] })]);
      expect(kinds(items)).toEqual(["time", "denied"]);
      expect(only(items, "denied").text).toBe(text);
    });
  });

  describe("status line", () => {
    const status = (active: Run) => only(itemsOf([active]), "status");

    it("waits to start while queued", () => {
      expect(status(run({ state: { kind: "queued" } }))).toMatchObject({ mode: "queued", text: "Waiting to start" });
    });

    it("thinks when no tool is waiting for a result", () => {
      const thinking = run({ state: { kind: "running" }, bodies: [{ kind: "userMessage", text: "hi" }] });
      expect(status(thinking)).toMatchObject({ mode: "thinking", text: "Thinking" });
      const afterTool = run({ state: { kind: "running" }, bodies: [turn("", [shell("ls")]), result("c1", "ok")] });
      expect(status(afterTool)).toMatchObject({ mode: "thinking", text: "Thinking" });
    });

    it("says a memory tool's step while it runs", () => {
      const running = (name: string) =>
        only(itemsOf([run({ state: { kind: "running" }, bodies: [turn("", [{ id: "c1", name, arguments: "{}" }])] })]), "status").text;
      expect(running("memory_save")).toBe("Saving a note");
      expect(running("memory_forget")).toBe("Forgetting a note");
      expect(running("description_set")).toBe("Updating its description");
    });

    it("names the first call of the newest turn with no result", () => {
      const calls = [shell("ls", "c1"), { id: "c2", name: "browser_navigate", arguments: "{}" }];
      const active = run({ state: { kind: "running" }, bodies: [turn("", calls), result("c1", "ok")] });
      expect(status(active)).toMatchObject({ mode: "tool", text: "Opening a page" });
    });

    it("thinks while a stream has no words yet", () => {
      const active = run({ state: { kind: "running" }, stream: { text: "", reasoning: undefined } });
      expect(status(active)).toMatchObject({ mode: "thinking" });
    });

    it("gives way to words that are arriving", () => {
      const items = itemsOf([run({ state: { kind: "running" }, stream: { text: "Hel", reasoning: "hmm" } })]);
      expect(kinds(items)).toEqual(["time", "assistant"]);
      expect(only(items, "assistant")).toMatchObject({ text: "Hel", streaming: true });
    });

    it("is gone when a run has ended", () => {
      expect(kinds(itemsOf([run({ bodies: [{ kind: "userMessage", text: "hi" }] })]))).toEqual(["time", "user"]);
    });
  });

  it("ends a failed or stopped run with what happened", () => {
    expect(only(itemsOf([run({ state: { kind: "failed", reason: "No key" } })]), "failed").reason).toBe("No key");
    expect(kinds(itemsOf([run({ state: { kind: "cancelled" } })]))).toEqual(["time", "stopped"]);
  });

  describe("time labels", () => {
    const at = (minutes: number) => NOW + minutes * 60 * 1000;
    const runs = (...minutes: number[]) => minutes.map((value, index) => run({ _id: id<"runs">(`r${index}`), createdAt: at(value) }));

    it("always labels the first run and then only after a gap of more than 15 minutes", () => {
      expect(kinds(itemsOf(runs(-100, -90, -75, -59)))).toEqual(["time", "time"]);
      expect(itemsOf(runs(-100, -90, -75, -59)).map((item) => item.key)).toEqual(["r0:time", "r3:time"]);
    });

    it("gives every item a unique key", () => {
      const twoRuns = [
        run({ _id: id<"runs">("r1"), bodies: [turn("a", [shell("ls")], "why"), result("c1", "ok")] }),
        run({ _id: id<"runs">("r2"), createdAt: at(60), bodies: [turn("b", [shell("ls")], "why"), result("c1", "ok")] }),
      ];
      const keys = itemsOf(twoRuns).map((item) => item.key);
      expect(new Set(keys).size).toBe(keys.length);
    });
  });
});

describe("timeLabel", () => {
  const label = (at: Date) => timeLabel({ at: at.getTime(), now: NOW, locale: "en-US" }).replaceAll(/\s/g, " ");

  it("says today and yesterday with the time", () => {
    expect(label(new Date(2026, 10, 6, 9, 12))).toBe("Today 9:12 AM");
    expect(label(new Date(2026, 10, 5, 18, 3))).toBe("Yesterday 6:03 PM");
  });

  it("goes by the calendar, not by 24 hours", () => {
    const justAfterMidnight = new Date(2026, 10, 7, 0, 5).getTime();
    const lateLastNight = new Date(2026, 10, 6, 23, 55).getTime();
    expect(timeLabel({ at: lateLastNight, now: justAfterMidnight, locale: "en-US" })).toMatch(/^Yesterday /);
  });

  it("uses the weekday for the last 6 days and a short date before that", () => {
    expect(label(new Date(2026, 10, 2, 7, 30))).toBe("Monday 7:30 AM");
    expect(label(new Date(2026, 9, 31, 7, 30))).toBe("Saturday 7:30 AM");
    expect(label(new Date(2026, 9, 30, 7, 30))).toBe("Oct 30");
    expect(label(new Date(2025, 9, 30, 7, 30))).toBe("Oct 30, 2025");
  });

  it("follows the locale", () => {
    expect(timeLabel({ at: new Date(2026, 10, 6, 15, 12).getTime(), now: NOW, locale: "sv-SE" })).toBe("Today 15:12");
  });

  it("treats a clock ahead of this device as today", () => {
    expect(label(new Date(2026, 10, 7, 9, 0))).toMatch(/^Today /);
  });
});
