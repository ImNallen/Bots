import type { Id } from "@bots/convex/dataModel";
import { describe, expect, it } from "vitest";
import { historyOf, threadEventOf, type HistoryItem } from "./history.ts";
import type { RunEventBody, ToolCall } from "./run-logic.ts";

const ask = (text: string): RunEventBody => ({ kind: "userMessage", text });

function call(id: string): ToolCall {
  return { id, name: "shell", arguments: '{"command":"ls"}' };
}

function turn(toolCalls: ToolCall[] = [], text = "", reasoning?: string): RunEventBody {
  return { kind: "assistantTurn", text, ...(reasoning === undefined ? {} : { reasoning }), toolCalls, usage: { promptTokens: 1, completionTokens: 1 }, model: "m" };
}

function result(toolCallId: string, output = "out"): RunEventBody {
  return { kind: "toolResult", toolCallId, name: "shell", outcome: "ok", output, exitCode: 0, truncated: false };
}

function stepOf(id: string, kibibytes: number): RunEventBody[] {
  return [turn([call(id)]), result(id, "x".repeat(kibibytes * 1024 - 21))];
}

function stepsOf(prefix: string, count: number, kibibytes: number): RunEventBody[] {
  return Array.from({ length: count }, (_, index) => stepOf(`${prefix}${index + 1}`, kibibytes)).flat();
}

const SENT_AT = Date.UTC(2026, 10, 10, 13, 3);
const stored = (events: RunEventBody[]) => events.map((body) => threadEventOf({ body, _creationTime: SENT_AT }));
const asked = (text: string) => ({ kind: "ask", body: ask(text), sentAt: SENT_AT });
const itemsOf = (events: RunEventBody[]) => historyOf(stored(events)).items;
const earlyEnds = (items: readonly HistoryItem[]) => items.filter((item) => item.kind === "endedEarly");
const listedNumbers = (items: readonly HistoryItem[]) => earlyEnds(items).flatMap((item) => item.listed.map((step) => step.number));
const wholeCalls = (items: readonly HistoryItem[]) => items.flatMap((item) => (item.kind === "result" ? [item.result.toolCallId] : []));
const NO_LIST = { kind: "endedEarly", unlisted: 0, listed: [] };

describe("historyOf", () => {
  it("folds an answered request to its ask and its reply", () => {
    const events = [ask("first"), turn([call("a")], "working", "why"), result("a"), turn([], "done", "because"), ask("second")];
    expect(itemsOf(events)).toEqual([
      asked("first"),
      { kind: "reply", text: "done" },
      asked("second"),
    ]);
  });

  it("takes a turn with a tool call, or with no text, as a step and not as the reply", () => {
    const calling = turn([call("a")], "Here is my answer.");
    const blank = turn([], "  ");
    expect(itemsOf([ask("first"), calling, result("a"), blank, ask("second")])).toEqual([
      asked("first"),
      { kind: "turn", turn: calling },
      { kind: "result", result: result("a") },
      { kind: "turn", turn: blank },
      NO_LIST,
      asked("second"),
    ]);
  });

  it("marks an ask that no run answered, also inside an exchange that a later run answered", () => {
    expect(itemsOf([ask("one"), ask("two"), turn([], "done"), ask("three")])).toEqual([
      asked("one"),
      NO_LIST,
      asked("two"),
      { kind: "reply", text: "done" },
      asked("three"),
    ]);
  });

  it("sends nothing for a result that no call came before", () => {
    expect(itemsOf([ask("first"), result("a")])).toEqual([asked("first")]);
  });

  it("gives each ask the time of its own row, a routine's instruction too, and gives work no time", () => {
    const fired: RunEventBody = { kind: "scheduleFired", scheduleId: "s" as Id<"schedules">, text: "Check the news." };
    const rows = [
      { body: ask("first"), _creationTime: 1000 },
      { body: turn([], "done"), _creationTime: 2000 },
      { body: fired, _creationTime: 3000 },
      { body: turn([call("a")]), _creationTime: 4000 },
      { body: result("a"), _creationTime: 5000 },
    ];
    const events = rows.map(threadEventOf);
    expect(events).toEqual([{ body: ask("first"), sentAt: 1000 }, { body: turn([], "done") }, { body: fired, sentAt: 3000 }, { body: turn([call("a")]) }, { body: result("a") }]);
    expect(events.filter((event) => "sentAt" in event)).toHaveLength(2);
    expect(historyOf(events).items).toEqual([
      { kind: "ask", body: ask("first"), sentAt: 1000 },
      { kind: "reply", text: "done" },
      { kind: "ask", body: fired, sentAt: 3000 },
      { kind: "turn", turn: turn([call("a")]) },
      { kind: "result", result: result("a") },
    ]);
  });

  it("gives the same history for the same events", () => {
    const events = [ask("one"), ...stepsOf("a", 3, 1), turn([], "done"), ask("two"), ...stepsOf("b", 30, 1), ask("three"), ...stepsOf("c", 4, 4)];
    expect(historyOf(structuredClone(stored(events)))).toEqual(historyOf(stored(events)));
  });
});

describe("historyOf with the steps of a run that stored no reply", () => {
  it("cuts nothing below 16 KiB of steps, and then cuts 8 KiB at a time", () => {
    const listed = (steps: number) => listedNumbers(itemsOf([ask("first"), ...stepsOf("a", steps, 1), ask("second")])).length;
    expect([15, 16, 23, 24].map(listed)).toEqual([0, 8, 8, 16]);
  });

  it("keeps the newest step whole whatever it weighs", () => {
    const alone = itemsOf([ask("first"), ...stepOf("big", 100), ask("second")]);
    expect(wholeCalls(alone)).toEqual(["big"]);
    expect(earlyEnds(alone)).toEqual([NO_LIST]);
    const afterOthers = itemsOf([ask("first"), ...stepOf("a", 1), ...stepOf("b", 1), ...stepOf("big", 100), ask("second")]);
    expect(wholeCalls(afterOthers)).toEqual(["big"]);
    expect(listedNumbers(afterOthers)).toEqual([1, 2]);
  });

  it("sends the same items for the earlier runs while the run it is in grows", () => {
    const earlier = [ask("first"), ...stepsOf("a", 30, 1), ask("second")];
    const before = itemsOf(earlier);
    const current = stepsOf("b", 20, 4);
    for (let results = 1; results <= 20; results += 1) {
      expect(itemsOf([...earlier, ...current.slice(0, results * 2)]).slice(0, before.length)).toEqual(before);
    }
  });

  it("lists a step's text, its calls, and how each ended, with no reasoning and no output", () => {
    const events: RunEventBody[] = [
      ask("first"),
      turn([call("a"), { id: "b", name: "read_file", arguments: '{"path":"a.txt"}' }], " Reading both. ", "a private thought"),
      result("a", "x".repeat(5000)),
      { kind: "toolResult", toolCallId: "b", name: "read_file", outcome: "error", output: "No such file.", truncated: false },
      ...stepOf("c", 12),
      ask("second"),
    ];
    expect(earlyEnds(itemsOf(events))).toEqual([
      {
        kind: "endedEarly",
        unlisted: 0,
        listed: [
          {
            number: 1,
            text: "Reading both.",
            calls: [
              { name: "shell", arguments: '{"command":"ls"}', outcome: "ok", exitCode: 0 },
              { name: "read_file", arguments: '{"path":"a.txt"}', outcome: "error" },
            ],
          },
        ],
      },
    ]);
  });

  it("cuts a listed step's text at 600 characters and its arguments at 160, and splits no character", () => {
    const face = String.fromCodePoint(0x1f600);
    const long = { id: "a", name: "shell", arguments: `{"command":"${face.repeat(200)}"}` };
    const [early] = earlyEnds(itemsOf([ask("first"), turn([long], face.repeat(700)), result("a", "x".repeat(4000)), ...stepOf("b", 12), ask("second")]));
    expect(early?.listed).toEqual([
      { number: 1, text: `${face.repeat(600)}...`, calls: [{ name: "shell", arguments: `{"command":"${face.repeat(148)}...`, outcome: "ok", exitCode: 0 }] },
    ]);
  });

  it("lists all of 89 steps behind the cut, and of 90 lists the newest 60 and counts the first 30", () => {
    const behind = (steps: number) => earlyEnds(itemsOf([ask("first"), ...stepsOf("a", steps, 1), ...stepOf("last", 15), ask("second")]))[0];
    expect(behind(89)?.unlisted).toBe(0);
    expect(behind(89)?.listed.map((step) => step.number)).toEqual(Array.from({ length: 89 }, (_, index) => index + 1));
    expect(behind(90)?.unlisted).toBe(30);
    expect(behind(90)?.listed.map((step) => step.number)).toEqual(Array.from({ length: 60 }, (_, index) => index + 31));
  });

  it("numbers the steps across two runs that stored no reply, and lists each run's steps in its own early end", () => {
    const items = itemsOf([ask("first"), ...stepsOf("a", 10, 1), ask("continue"), ...stepsOf("b", 14, 1), ask("third")]);
    expect(earlyEnds(items).map((item) => item.listed.map((step) => step.number))).toEqual([
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      [11, 12, 13, 14, 15, 16],
    ]);
    expect(wholeCalls(items)).toEqual(["b7", "b8", "b9", "b10", "b11", "b12", "b13", "b14"]);
  });
});

describe("historyOf weights", () => {
  it("weighs the same for a chat's first run, stored and sent", () => {
    expect(historyOf(stored([ask("hi"), turn([call("a")]), result("a")]))).toMatchObject({ storedBytes: 26, sentBytes: 26 });
  });

  it("counts UTF-8 bytes, and leaves out the work of an answered request", () => {
    const events = [ask("héllo"), turn([call("a")], "", "why"), result("a"), turn([], "done"), ask("again")];
    expect(historyOf(stored(events))).toMatchObject({ storedBytes: 42, sentBytes: 15 });
  });

  it("counts a listed step as its text and its cut calls, without its output", () => {
    const written = JSON.stringify({ path: "notes.txt", content: "y".repeat(200) });
    const events: RunEventBody[] = [
      ask("first"),
      turn([call("a")], "Listing the files."),
      result("a", "x".repeat(4057)),
      turn([{ id: "b", name: "write_file", arguments: written }]),
      { kind: "toolResult", toolCallId: "b", name: "write_file", outcome: "error", output: "x".repeat(3853), truncated: false },
      ...stepsOf("c", 3, 4),
      ask("second"),
    ];
    expect(historyOf(stored(events))).toMatchObject({ storedBytes: 5 + 5 * 4096 + 6, sentBytes: 5 + 3 * 4096 + (18 + 21) + (10 + 163) + 6 });
  });
});
