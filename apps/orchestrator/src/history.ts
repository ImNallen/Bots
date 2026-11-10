import type { Doc } from "@bots/convex/dataModel";

type RunEventBody = Doc<"runEvents">["body"];
type Ask = Extract<RunEventBody, { kind: "userMessage" | "scheduleFired" }>;
type AssistantTurn = Extract<RunEventBody, { kind: "assistantTurn" }>;
type ToolResultBody = Extract<RunEventBody, { kind: "toolResult" }>;

// A stored event as the orchestrator holds it. Convex stores every ask, so each has the time of its row.
export type ThreadEvent = { body: Ask; sentAt: number } | { body: Exclude<RunEventBody, Ask> };

export function threadEventOf(row: Pick<Doc<"runEvents">, "body" | "_creationTime">): ThreadEvent {
  const { body } = row;
  return body.kind === "userMessage" || body.kind === "scheduleFired" ? { body, sentAt: row._creationTime } : { body };
}

export type LoggedCall = { name: string; arguments: string; outcome: ToolResultBody["outcome"]; exitCode?: number };
export type LoggedStep = { number: number; text: string; calls: readonly LoggedCall[] };

export type HistoryItem =
  | { kind: "ask"; body: Ask; sentAt: number }
  | { kind: "report"; text: string }
  | { kind: "reply"; text: string }
  | { kind: "endedEarly"; unlisted: number; listed: readonly LoggedStep[] }
  | { kind: "turn"; turn: AssistantTurn }
  | { kind: "result"; result: ToolResultBody };

export type History = { items: readonly HistoryItem[]; storedBytes: number; sentBytes: number };

type Step = { number: number; turn: AssistantTurn; results: ToolResultBody[] };
type Shown = Extract<HistoryItem, { kind: "ask" | "report" }>;
type Part = Shown | { kind: "step"; step: Step };
type ClosedExchange = { parts: readonly Shown[]; reply: string };
type Thread = { closed: readonly ClosedExchange[]; open: readonly Part[] };

type Window = { keep: number; page: number };

const KIB = 1024;
const WORK_WINDOW: Window = { keep: 8 * KIB, page: 8 * KIB };
const LOG_WINDOW: Window = { keep: 60, page: 30 };
const REPORTS_A_MODEL_READS = 3;
const LISTED_TEXT_CHARACTERS = 600;
const LISTED_ARGUMENTS_CHARACTERS = 160;

function threadOf(events: readonly ThreadEvent[]): Thread {
  const closed: ClosedExchange[] = [];
  let parts: Part[] = [];
  let steps = 0;
  let reportsToSkip = events.filter((event) => event.body.kind === "routineReport").length - REPORTS_A_MODEL_READS;
  for (const stored of events) {
    if ("sentAt" in stored) {
      parts.push({ kind: "ask", ...stored });
      continue;
    }
    const event = stored.body;
    switch (event.kind) {
      case "routineReport":
        reportsToSkip -= 1;
        if (reportsToSkip < 0) {
          parts.push({ kind: "report", text: event.text });
        }
        break;
      case "assistantTurn":
        if (event.toolCalls.length === 0 && event.text.trim() !== "") {
          closed.push({ parts: parts.filter((part) => part.kind !== "step"), reply: event.text });
          parts = [];
          steps = 0;
        } else {
          steps += 1;
          parts.push({ kind: "step", step: { number: steps, turn: event, results: [] } });
        }
        break;
      case "toolResult":
        // A result with no step before it answers no call, and a request must not hold a tool message without its call.
        parts.findLast((part) => part.kind === "step")?.step.results.push(event);
        break;
      default:
        event satisfies never;
    }
  }
  return { closed, open: parts };
}

function sum(weights: readonly number[]): number {
  return weights.reduce((total, weight) => total + weight, 0);
}

function pagedCut(weights: readonly number[], window: Window): number {
  const line = Math.floor(Math.max(0, sum(weights) - window.keep) / window.page) * window.page;
  if (line === 0) {
    return 0;
  }
  let behind = 0;
  let end = 0;
  for (const weight of weights) {
    end += weight;
    if (end > line) {
      break;
    }
    behind += 1;
  }
  return behind;
}

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function callBytes(call: { name: string; arguments: string }): number {
  return bytes(call.name) + bytes(call.arguments);
}

function eventBytes(event: RunEventBody): number {
  switch (event.kind) {
    case "userMessage":
    case "scheduleFired":
    case "routineReport":
      return bytes(event.text);
    case "assistantTurn":
      return bytes(event.reasoning ?? "") + bytes(event.text) + sum(event.toolCalls.map(callBytes));
    case "toolResult":
      return bytes(event.output);
  }
}

function stepBytes(step: Step): number {
  return eventBytes(step.turn) + sum(step.results.map(eventBytes));
}

function itemBytes(item: HistoryItem): number {
  switch (item.kind) {
    case "ask":
      return eventBytes(item.body);
    case "report":
    case "reply":
      return bytes(item.text);
    case "endedEarly":
      return sum(item.listed.map((step) => bytes(step.text) + sum(step.calls.map(callBytes))));
    case "turn":
      return eventBytes(item.turn);
    case "result":
      return eventBytes(item.result);
  }
}

// By code point, so no character splits.
function cut(text: string, characters: number): string {
  const points = Array.from(text);
  return points.length <= characters ? text : `${points.slice(0, characters).join("")}...`;
}

function loggedStep(step: Step): LoggedStep {
  return {
    number: step.number,
    text: cut(step.turn.text.trim(), LISTED_TEXT_CHARACTERS),
    calls: step.turn.toolCalls.flatMap((call) => {
      const result = step.results.find((entry) => entry.toolCallId === call.id);
      if (result === undefined) {
        return [];
      }
      const exitCode = result.exitCode === undefined ? {} : { exitCode: result.exitCode };
      return [{ name: call.name, arguments: cut(call.arguments, LISTED_ARGUMENTS_CHARACTERS), outcome: result.outcome, ...exitCode }];
    }),
  };
}

export function historyOf(events: readonly ThreadEvent[]): History {
  const { closed, open } = threadOf(events);
  const newestAsk = Math.max(0, open.findLastIndex((part) => part.kind === "ask"));
  const earlierRuns = open.slice(0, newestAsk);
  const thisRun = open.slice(newestAsk);
  const logged = pagedCut(earlierRuns.flatMap((part) => (part.kind === "step" ? [stepBytes(part.step)] : [])), WORK_WINDOW);
  const unlisted = pagedCut(Array<number>(logged).fill(1), LOG_WINDOW);

  const items: HistoryItem[] = [];
  let earlierRun: Step[] = [];
  const whole = (step: Step): void => {
    items.push({ kind: "turn", turn: step.turn }, ...step.results.map((result) => ({ kind: "result" as const, result })));
  };
  const endEarlierRun = (): void => {
    if (earlierRun.length > 0) {
      earlierRun.filter((step) => step.number > logged).forEach(whole);
      items.push({
        kind: "endedEarly",
        unlisted: earlierRun.filter((step) => step.number <= unlisted).length,
        listed: earlierRun.filter((step) => step.number > unlisted && step.number <= logged).map(loggedStep),
      });
      earlierRun = [];
    } else if (items.at(-1)?.kind === "ask") {
      items.push({ kind: "endedEarly", unlisted: 0, listed: [] });
    }
  };

  for (const exchange of closed) {
    for (const part of exchange.parts) {
      endEarlierRun();
      items.push(part);
    }
    items.push({ kind: "reply", text: exchange.reply });
  }
  for (const part of earlierRuns) {
    if (part.kind === "step") {
      earlierRun.push(part.step);
    } else {
      endEarlierRun();
      items.push(part);
    }
  }
  for (const part of thisRun) {
    if (part.kind === "step") {
      whole(part.step);
    } else {
      endEarlierRun();
      items.push(part);
    }
  }
  return { items, storedBytes: sum(events.map((event) => eventBytes(event.body))), sentBytes: sum(items.map(itemBytes)) };
}
