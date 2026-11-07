import { describe, expect, it } from "vitest";
import type { Id } from "./_generated/dataModel.js";
import { capText, decideActivity, lastMessageOf, listingOf, runRow, upcomingRows } from "./activity.js";
import type { RunEventBody, RunState } from "./validators.js";

const NOW = 1_000_000;
const RUNNING: RunState = { kind: "running", leaseToken: "lease", leaseUntil: NOW + 1000 };
const FAILED: RunState = { kind: "failed", reason: "It broke." };

const user = (text: string): RunEventBody => ({ kind: "userMessage", text });
const turn = (text: string, ...toolCalls: string[]): RunEventBody => ({
  kind: "assistantTurn",
  text,
  toolCalls: toolCalls.map((name) => ({ id: `id-${name}`, name, arguments: "{}" })),
  usage: { promptTokens: 1, completionTokens: 1 },
  model: "model",
});
const result = (name: string): RunEventBody => ({
  kind: "toolResult",
  toolCallId: `id-${name}`,
  name,
  outcome: "ok",
  output: "",
  truncated: false,
});

function activity(overrides: Partial<Parameters<typeof decideActivity>[0]>) {
  return decideActivity({
    hasPendingApproval: false,
    runState: null,
    newestEvents: [],
    ...overrides,
  });
}

describe("decideActivity", () => {
  it("is idle with no run, and after a run that ended without failing", () => {
    expect(activity({})).toEqual({ kind: "idle" });
    expect(activity({ runState: { kind: "done" } })).toEqual({ kind: "idle" });
    expect(activity({ runState: { kind: "cancelled" } })).toEqual({ kind: "idle" });
  });

  it("reports a queued run and a failed last run", () => {
    expect(activity({ runState: { kind: "queued" } })).toEqual({ kind: "queued" });
    expect(activity({ runState: FAILED })).toEqual({ kind: "failed" });
  });

  it("puts approval before the run", () => {
    expect(activity({ hasPendingApproval: true, runState: RUNNING })).toEqual({ kind: "needsApproval" });
    expect(activity({ runState: RUNNING }).kind).toBe("running");
  });

  it("ignores a pending approval left on a run that has ended", () => {
    expect(activity({ hasPendingApproval: true, runState: { kind: "cancelled" } })).toEqual({ kind: "idle" });
    expect(activity({ hasPendingApproval: true, runState: FAILED })).toEqual({ kind: "failed" });
  });

  it("names the first unanswered tool of the newest turn", () => {
    const newestEvents = [result("shell"), turn("", "shell", "read_file"), user("go")];
    expect(activity({ runState: RUNNING, newestEvents })).toEqual({ kind: "running", tool: "read_file" });
  });

  it("names no tool while the bot waits on the model", () => {
    const answered = [result("shell"), turn("", "shell"), user("go")];
    expect(activity({ runState: RUNNING, newestEvents: answered })).toEqual({ kind: "running", tool: null });
    expect(activity({ runState: RUNNING, newestEvents: [user("go")] })).toEqual({ kind: "running", tool: null });
  });
});

describe("lastMessageOf", () => {
  it("is null when there is no text", () => {
    expect(lastMessageOf([])).toBeNull();
    expect(lastMessageOf([result("shell"), turn("", "shell")])).toBeNull();
  });

  it("takes the newest user or assistant text and skips turns with none", () => {
    expect(lastMessageOf([turn("Done."), user("go")])).toBe("Done.");
    expect(lastMessageOf([result("shell"), turn("  ", "shell"), user("go")])).toBe("go");
  });

  it("puts a multi-line message on one line", () => {
    expect(lastMessageOf([turn("  First\n\n  second  ")])).toBe("First second");
  });

  it("reads a routine's report in the chat as the last message", () => {
    const report: RunEventBody = { kind: "routineReport", scheduleId: "s" as Id<"schedules">, runId: "r" as Id<"runs">, text: "Version 2 shipped." };
    expect(lastMessageOf([report])).toBe("Version 2 shipped.");
  });

  it("caps at 140 characters without splitting an emoji", () => {
    expect(lastMessageOf([user("a".repeat(141))])).toBe("a".repeat(140));
    expect(lastMessageOf([user(`${"a".repeat(139)}😀`)])).toBe("a".repeat(139));
  });
});

describe("capText", () => {
  it("keeps text at the limit and cuts text over it", () => {
    expect(capText("a".repeat(8000), 8000)).toHaveLength(8000);
    expect(capText("a".repeat(8001), 8000)).toHaveLength(8000);
  });

  it("does not split an emoji at the cut", () => {
    expect(capText(`${"a".repeat(7999)}😀`, 8000)).toBe("a".repeat(7999));
  });
});

describe("the Activity page's rows", () => {
  const bot = { _id: "bot" as Id<"bots">, name: "Scout", shape: "ball" as const, color: "teal" as const };
  const botOf = (botId: Id<"bots">) => (botId === bot._id ? bot : undefined);
  const scheduleId = "routine" as Id<"schedules">;
  const run = {
    _id: "run" as Id<"runs">,
    _creationTime: NOW,
    botId: bot._id,
    trigger: "user" as const,
    scheduleId: undefined,
    state: { kind: "done" } as RunState,
    endedAt: NOW + 5,
  };
  const rawRun = { ...run, _id: "raw" as Id<"runs">, trigger: "schedule" as const, scheduleId };
  const reportRow = { ...run, _id: "report" as Id<"runs">, trigger: "schedule" as const };
  const row = (overrides: Partial<Parameters<typeof runRow>[0]>) =>
    runRow({ run, bot, instructionOf: () => "Check the news", newestEvents: [], blocked: false, ...overrides });

  describe("listingOf", () => {
    const listed = (runs: readonly (typeof run | typeof rawRun | typeof reportRow)[]) => runs.flatMap((candidate) => listingOf(candidate, botOf)?.run._id ?? []);

    it("shows a fire once, as the routine's own run, and not its report row", () => {
      expect(listed([reportRow, rawRun])).toEqual(["raw"]);
    });

    it("lists no report whose raw run has been purged", () => {
      expect(listed([reportRow])).toEqual([]);
    });

    it("lists a chat run and a routine's run with no report, such as a failed one", () => {
      expect(listed([run, { ...rawRun, state: { kind: "failed", reason: "It broke." } }])).toEqual(["run", "raw"]);
    });

    it("lists no run of a bot that is gone", () => {
      expect(listed([{ ...run, botId: "gone" as Id<"bots"> }, { ...rawRun, botId: "gone" as Id<"bots"> }])).toEqual([]);
    });

    it("hands back the bot with the run", () => {
      expect(listingOf(run, botOf)?.bot).toBe(bot);
    });
  });

  describe("runRow", () => {
    it("names a routine's run by its instruction, on one line", () => {
      expect(row({ run: rawRun, instructionOf: () => "Check\n\n  the news" }).instruction).toBe("Check the news");
    });

    it("names a chat run by nothing", () => {
      expect(row({}).instruction).toBeNull();
    });

    it("has no name for a routine that was deleted, and the row still builds", () => {
      const shown = row({ run: rawRun, instructionOf: () => undefined });
      expect(shown.trigger).toBe("schedule");
      expect(shown.instruction).toBeNull();
    });

    it("has no text for a run with none, and for a routine's run that only holds its instruction", () => {
      expect(row({ newestEvents: [] }).lastText).toBeNull();
      expect(row({ newestEvents: [result("shell"), turn("", "shell")] }).lastText).toBeNull();
      const fired: RunEventBody = { kind: "scheduleFired", scheduleId, text: "Check the news" };
      expect(row({ run: rawRun, newestEvents: [fired] }).lastText).toBeNull();
      expect(row({ run: rawRun, newestEvents: [result("read_file"), turn("", "read_file"), fired] }).lastText).toBeNull();
    });

    it("takes the newest text, on one line, cut before it can split an emoji", () => {
      expect(row({ newestEvents: [turn("  Done.\n\nAll of it."), user("go")] }).lastText).toBe("Done. All of it.");
      expect(row({ newestEvents: [turn(`${"a".repeat(279)}😀`)] }).lastText).toBe("a".repeat(279));
    });

    it("hides a running run's lease, and keeps a failure's reason", () => {
      const running = row({ run: { ...run, state: { kind: "running", leaseToken: "secret-lease", leaseUntil: NOW } } });
      expect(running.state).toEqual({ kind: "running" });
      expect(JSON.stringify(running)).not.toContain("secret-lease");
      expect(row({ run: { ...run, state: { kind: "failed", reason: "It broke." } } }).state).toEqual({ kind: "failed", reason: "It broke." });
    });

    it("carries the bot's look, the times, and blocked, and nothing else of the bot", () => {
      const shown = row({ bot: { ...bot, description: "private" } as typeof bot, blocked: true });
      expect(shown).toMatchObject({ bot, createdAt: NOW, endedAt: NOW + 5, blocked: true });
      expect(JSON.stringify(shown)).not.toContain("private");
    });
  });

  describe("upcomingRows", () => {
    const routine = {
      _id: scheduleId,
      botId: bot._id,
      instruction: "Check the news",
      cadence: { kind: "everyHours" as const, hours: 6 },
      nextFireAt: NOW,
      pausedBecause: undefined,
      lastMissed: undefined,
    };
    const named = (instruction: string, nextFireAt: number | undefined) => ({ ...routine, instruction, nextFireAt });
    const upcoming = (routines: Parameters<typeof upcomingRows>[0]["routines"]) => upcomingRows({ routines, botOf, timeZone: "UTC" });

    it("puts the soonest first and paused routines last, in the order they came", () => {
      const routines = [named("paused one", undefined), named("later", NOW + 2), named("paused two", undefined), named("soon", NOW + 1)];
      expect(upcoming(routines).map((row) => row.instruction)).toEqual(["soon", "later", "paused one", "paused two"]);
    });

    it("has words for when, and an absent next time for a paused routine", () => {
      expect(upcoming([named("paused", undefined)])[0]).toMatchObject({ when: "Every 6 hours", bot });
      expect(upcoming([named("paused", undefined)])[0]?.nextFireAt).toBeUndefined();
    });

    it("keeps a routine's last miss and why it paused itself", () => {
      const lastMissed = { at: NOW, reason: "The bot was busy" };
      const [paused] = upcoming([{ ...routine, nextFireAt: undefined, pausedBecause: "It paused itself", lastMissed }]);
      expect(paused).toMatchObject({ pausedBecause: "It paused itself", lastMissed });
    });

    it("lists no routine of a bot that is gone", () => {
      expect(upcoming([{ ...routine, botId: "gone" as Id<"bots"> }])).toEqual([]);
    });
  });
});
