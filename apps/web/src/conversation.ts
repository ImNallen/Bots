import type { api } from "@bots/convex";
import type { Doc, Id } from "@bots/convex/dataModel";
import { describeCadence, parseCadence } from "@bots/convex/scheduleTime";
import type { ToolName } from "@bots/protocol";
import type { FunctionReturnType } from "convex/server";
import { friendlyStep, isToolName, TOOL_STEPS } from "./activity.ts";
import type { IconName } from "./Icon.tsx";

export type Timeline = FunctionReturnType<typeof api.threads.timeline>;
type TimelineRun = Timeline["runs"][number];
type EventBody = Doc<"runEvents">["body"];
type AssistantTurn = Extract<EventBody, { kind: "assistantTurn" }>;
type ToolCall = AssistantTurn["toolCalls"][number];
type ToolResult = Extract<EventBody, { kind: "toolResult" }>;
export type PendingApproval = FunctionReturnType<typeof api.approvals.pendingForThread>[number];

export type ToolStatus = "running" | "finished" | "failed";
export type ToolOutput = { text: string; exitCode: number | undefined; truncated: boolean };
export type CallArgument = { label: string | null; value: string };

export type DisplayItem = { key: string } & (
  | { kind: "time"; label: string }
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; streaming: boolean }
  | { kind: "report"; text: string }
  | { kind: "reasoning"; text: string }
  | {
      kind: "tool";
      name: string;
      icon: IconName;
      summary: string;
      status: ToolStatus;
      note: string | null;
      output: ToolOutput | null;
    }
  | { kind: "approval"; approvalId: Id<"approvals">; title: string; arguments: CallArgument[] }
  | { kind: "denied"; text: string }
  | { kind: "failed"; reason: string }
  | { kind: "stopped" }
  | { kind: "status"; mode: "queued" | "thinking" | "tool"; text: string }
);

const TIME_GAP_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAY_DAYS = 6;

const TOOL_WORDS = {
  shell: { done: "Ran a command", ask: "Run this command?", icon: "terminal" },
  read_file: { done: "Read a file", ask: "Read this file?", icon: "file" },
  write_file: { done: "Saved a file", ask: "Save this file?", icon: "file" },
  browser_navigate: { done: "Opened a page", ask: "Open this page?", icon: "globe" },
  browser_snapshot: { done: "Read the page", ask: "Read this page?", icon: "lines" },
  browser_click: { done: "Clicked on the page", ask: "Click on this page?", icon: "pointer" },
  browser_type: { done: "Typed on the page", ask: "Type on this page?", icon: "text" },
  browser_press: { done: "Pressed a key", ask: "Press this key?", icon: "key" },
  memory_save: { done: "Saved a note", ask: "Save this note?", icon: "text" },
  memory_forget: { done: "Forgot a note", ask: "Forget this note?", icon: "close" },
  schedule_propose: { done: "Created a routine", ask: "Create this routine?", icon: "lines" },
} as const satisfies Record<ToolName, { done: string; ask: string; icon: IconName }>;

// A denied result has no row at all, so this table has no entry for it.
const OUTCOMES: Record<Exclude<ToolResult["outcome"], "denied">, { status: ToolStatus; note: string | null }> = {
  ok: { status: "finished", note: null },
  cancelled: { status: "finished", note: "stopped" },
  error: { status: "failed", note: "failed" },
  timeout: { status: "failed", note: "timed out" },
  interrupted: { status: "failed", note: "interrupted" },
  unavailable: { status: "failed", note: "no computer answered" },
  invalid: { status: "failed", note: "invalid call" },
  rejected: { status: "failed", note: "blocked, read-only run" },
};

export function isActive(run: Pick<TimelineRun, "state">): boolean {
  return run.state.kind === "queued" || run.state.kind === "running";
}

function parseObject(raw: string): object | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function callSummary(raw: string): string {
  const parsed = parseObject(raw);
  if (parsed === null) {
    return raw;
  }
  const values = Object.values(parsed);
  const first: unknown = values.find((value) => typeof value === "string");
  if (typeof first === "string") {
    return first;
  }
  return values.length === 0 ? "" : raw;
}

// A person can only approve what they can read, so every argument shows in full, and a string keeps its line breaks. Each one
// is its own entry, so text inside one argument cannot pass for another.
function callArguments(raw: string): CallArgument[] {
  const parsed = parseObject(raw);
  if (parsed === null) {
    return [{ label: null, value: raw }];
  }
  const entries = Object.entries(parsed) as [string, unknown][];
  const [only] = entries;
  if (entries.length === 1 && only !== undefined && typeof only[1] === "string") {
    return [{ label: null, value: only[1] }];
  }
  return entries.map(([label, value]) => ({
    label,
    value: typeof value === "string" ? value : JSON.stringify(value, null, 2),
  }));
}

function routineCard(raw: string, timeZone: string): { title: string; arguments: CallArgument[] } | null {
  const parsed = parseObject(raw) as { instruction?: unknown; cadence?: unknown } | null;
  const cadence = parseCadence(parsed?.cadence);
  return cadence === null || typeof parsed?.instruction !== "string"
    ? null
    : { title: `${TOOL_WORDS.schedule_propose.ask} ${describeCadence(cadence, timeZone)}.`, arguments: [{ label: null, value: parsed.instruction }] };
}

function startOfDay(at: number): number {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function timeLabel(args: { at: number; now: number; locale: string }): string {
  const { at, now, locale } = args;
  const time = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(at);
  // Rounded, because a day with a clock change is not 24 hours long.
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY_MS);
  if (days <= 0) {
    return `Today ${time}`;
  }
  if (days === 1) {
    return `Yesterday ${time}`;
  }
  if (days <= WEEKDAY_DAYS) {
    return `${new Intl.DateTimeFormat(locale, { weekday: "long" }).format(at)} ${time}`;
  }
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
  }).format(at);
}

function callItem(args: {
  key: string;
  call: ToolCall;
  result: ToolResult | undefined;
  active: boolean;
  approvalId: Id<"approvals"> | undefined;
  timeZone: string;
}): DisplayItem {
  const { key, call, result, active, approvalId, timeZone } = args;
  const known = isToolName(call.name) ? call.name : null;
  const icon: IconName = known === null ? "gear" : TOOL_WORDS[known].icon;
  const row = { key, kind: "tool" as const, icon, summary: callSummary(call.arguments) };
  const doneName = known === null ? call.name : TOOL_WORDS[known].done;
  if (result === undefined) {
    if (approvalId !== undefined) {
      const routine = known === "schedule_propose" ? routineCard(call.arguments, timeZone) : null;
      return {
        key,
        kind: "approval",
        approvalId,
        title: routine?.title ?? (known === null ? `Run ${call.name}?` : TOOL_WORDS[known].ask),
        arguments: routine?.arguments ?? callArguments(call.arguments),
      };
    }
    // A row that is still running must not claim the past tense.
    return active
      ? { ...row, name: known === null ? call.name : TOOL_STEPS[known], status: "running", note: null, output: null }
      : { ...row, name: doneName, status: "finished", note: "no result", output: null };
  }
  const { outcome } = result;
  if (outcome === "denied") {
    return { key, kind: "denied", text: result.output };
  }
  return {
    ...row,
    name: doneName,
    ...OUTCOMES[outcome],
    output: { text: result.output, exitCode: result.exitCode, truncated: result.truncated },
  };
}

// The first call of the newest turn with no result is the step the bot is on. With none, it is waiting on the model.
function currentTool(run: TimelineRun): string | null {
  const answered = new Set<string>();
  for (const { body } of run.events.toReversed()) {
    if (body.kind === "toolResult") {
      answered.add(body.toolCallId);
    } else if (body.kind === "assistantTurn") {
      return body.toolCalls.find((call) => !answered.has(call.id))?.name ?? null;
    }
  }
  return null;
}

function statusItem(args: { run: TimelineRun; waitingForAnswer: boolean }): DisplayItem | null {
  const { run, waitingForAnswer } = args;
  const key = `${run._id}:status`;
  if (run.state.kind === "queued") {
    return { key, kind: "status", mode: "queued", text: "Waiting to start" };
  }
  // A question card is already asking, and text that is arriving already shows what the bot is doing.
  if (run.state.kind !== "running" || waitingForAnswer || (run.stream !== null && run.stream.text !== "")) {
    return null;
  }
  const tool = run.stream === null ? currentTool(run) : null;
  return { key, kind: "status", mode: tool === null ? "thinking" : "tool", text: friendlyStep(tool) };
}

function runItems(args: { run: TimelineRun; approvals: ReadonlyMap<string, Id<"approvals">>; timeZone: string }): DisplayItem[] {
  const { run, approvals, timeZone } = args;
  const active = isActive(run);
  const results = new Map(
    run.events
      .map((event) => event.body)
      .filter((body) => body.kind === "toolResult")
      .map((body) => [body.toolCallId, body]),
  );
  const items: DisplayItem[] = [];
  let waitingForAnswer = false;
  for (const { _id, body } of run.events) {
    switch (body.kind) {
      case "userMessage":
        items.push({ key: _id, kind: "user", text: body.text });
        break;
      case "routineReport":
        items.push({ key: _id, kind: "report", text: body.text });
        break;
      case "assistantTurn":
        if (body.reasoning !== undefined) {
          items.push({ key: `${_id}:reasoning`, kind: "reasoning", text: body.reasoning });
        }
        if (body.text.trim() !== "") {
          items.push({ key: `${_id}:text`, kind: "assistant", text: body.text, streaming: false });
        }
        for (const call of body.toolCalls) {
          const item = callItem({
            key: `${run._id}:${call.id}`,
            call,
            result: results.get(call.id),
            active,
            approvalId: approvals.get(`${run._id}:${call.id}`),
            timeZone,
          });
          waitingForAnswer ||= item.kind === "approval";
          items.push(item);
        }
        break;
      case "toolResult":
      case "scheduleFired":
        break;
      default:
        body satisfies never;
    }
  }
  if (run.stream !== null) {
    if (run.stream.reasoning !== undefined) {
      items.push({ key: `${run._id}:stream:reasoning`, kind: "reasoning", text: run.stream.reasoning });
    }
    if (run.stream.text !== "") {
      items.push({ key: `${run._id}:stream:text`, kind: "assistant", text: run.stream.text, streaming: true });
    }
  }
  const status = statusItem({ run, waitingForAnswer });
  if (status !== null) {
    items.push(status);
  }
  if (run.state.kind === "failed") {
    items.push({ key: `${run._id}:failed`, kind: "failed", reason: run.state.reason });
  } else if (run.state.kind === "cancelled") {
    items.push({ key: `${run._id}:stopped`, kind: "stopped" });
  }
  return items;
}

export function conversationItems(args: {
  timeline: Timeline;
  pending: readonly PendingApproval[];
  now: number;
  locale: string;
  timeZone: string;
}): DisplayItem[] {
  const { timeline, pending, now, locale, timeZone } = args;
  const approvals = new Map(pending.map((row) => [`${row.runId}:${row.toolCallId}`, row._id]));
  return timeline.runs.flatMap((run, index) => {
    const previous = timeline.runs[index - 1];
    const showTime = previous === undefined || run.createdAt - previous.createdAt > TIME_GAP_MS;
    const time: DisplayItem[] = showTime
      ? [{ key: `${run._id}:time`, kind: "time", label: timeLabel({ at: run.createdAt, now, locale }) }]
      : [];
    return [...time, ...runItems({ run, approvals, timeZone })];
  });
}
