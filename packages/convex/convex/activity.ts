import type { Doc, Id } from "./_generated/dataModel.js";
import { query, type QueryCtx } from "./_generated/server.js";
import { requireIdentity } from "./identity.js";
import { FALLBACK_ZONE, describeCadence } from "./scheduleTime.js";
import { isActive, publicState } from "./threads.js";
import type { RunEventBody, RunState } from "./validators.js";

export type BotActivity =
  | { kind: "idle" }
  | { kind: "queued" }
  | { kind: "running"; tool: string | null }
  | { kind: "needsApproval" }
  | { kind: "failed" };

const MAX_LAST_MESSAGE_LENGTH = 140;
const EVENTS_PER_RUN = 6;
// A query may read 16 MiB and one event can be 1 MiB.
export const TEXT_READ_BYTES = 8 * 1024 * 1024;
const LISTED_RUNS = 50;
const MAX_RUNS_SCANNED = 2000;
const ROW_TEXT_OVER_TWO_LINES = 280;
const encoder = new TextEncoder();

// With no unanswered call in the newest turn, the bot is waiting on the model.
function runningTool(newestEvents: readonly RunEventBody[]): string | null {
  const answered = new Set<string>();
  for (const event of newestEvents) {
    if (event.kind === "toolResult") {
      answered.add(event.toolCallId);
    } else if (event.kind === "assistantTurn") {
      return event.toolCalls.find((call) => !answered.has(call.id))?.name ?? null;
    }
  }
  return null;
}

export function decideActivity(args: {
  hasPendingApproval: boolean;
  runState: RunState | null;
  newestEvents: readonly RunEventBody[];
}): BotActivity {
  const { hasPendingApproval, runState, newestEvents } = args;
  // An approval stays pending on a run that ended without an answer, and nobody can answer it any more.
  if (hasPendingApproval && runState !== null && isActive(runState)) {
    return { kind: "needsApproval" };
  }
  switch (runState?.kind) {
    case "running":
      return { kind: "running", tool: runningTool(newestEvents) };
    case "queued":
      return { kind: "queued" };
    case "failed":
      return { kind: "failed" };
    default:
      return { kind: "idle" };
  }
}

// Convex refuses a string with half of a surrogate pair, so a cut must not split an emoji.
export function capText(text: string, max: number): string {
  const cut = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

function oneLine(text: string, max: number): string {
  return capText(text.replace(/\s+/g, " ").trim(), max);
}

export function lastMessageOf(newestEvents: readonly RunEventBody[], max = MAX_LAST_MESSAGE_LENGTH): string | null {
  for (const event of newestEvents) {
    if (event.kind !== "toolResult") {
      const text = oneLine(event.text, max);
      if (text !== "") {
        return text;
      }
    }
  }
  return null;
}

function bytesOf(event: Doc<"runEvents">): number {
  return encoder.encode(JSON.stringify(event)).length;
}

export async function newestEventsUpToText(ctx: QueryCtx, runId: Id<"runs">, budget: { bytes: number }): Promise<RunEventBody[]> {
  if (budget.bytes <= 0) {
    return [];
  }
  const events: RunEventBody[] = [];
  const spend = (event: Doc<"runEvents">) => {
    budget.bytes -= bytesOf(event);
    events.push(event.body);
  };
  for await (const event of ctx.db
    .query("runEvents")
    .withIndex("by_run_seq", (q) => q.eq("runId", runId))
    .order("desc")) {
    spend(event);
    if (lastMessageOf([event.body]) !== null) {
      return events;
    }
    if (events.length === EVENTS_PER_RUN || budget.bytes <= 0) {
      break;
    }
  }
  if (budget.bytes > 0) {
    const opening = await ctx.db
      .query("runEvents")
      .withIndex("by_run_seq", (q) => q.eq("runId", runId))
      .first();
    if (opening !== null) {
      spend(opening);
    }
  }
  return events;
}

type BotLook = Pick<Doc<"bots">, "_id" | "name" | "shape" | "color">;
type ListedRun = Pick<Doc<"runs">, "_id" | "_creationTime" | "botId" | "trigger" | "scheduleId" | "state" | "endedAt">;
type UpcomingRoutine = Pick<Doc<"schedules">, "_id" | "botId" | "instruction" | "cadence" | "nextFireAt" | "pausedBecause" | "lastMissed">;

function lookOf({ _id, name, shape, color }: BotLook): BotLook {
  return { _id, name, shape, color };
}

export function listingOf<Run extends Pick<ListedRun, "botId" | "trigger" | "scheduleId">>(run: Run, botOf: (botId: Id<"bots">) => BotLook | undefined): { run: Run; bot: BotLook } | null {
  const isReport = run.trigger === "schedule" && run.scheduleId === undefined;
  const bot = botOf(run.botId);
  return isReport || bot === undefined ? null : { run, bot };
}

export function runRow(args: {
  run: ListedRun;
  bot: BotLook;
  instructionOf: (scheduleId: Id<"schedules">) => string | undefined;
  newestEvents: readonly RunEventBody[];
  blocked: boolean;
}) {
  const { run, bot, instructionOf, newestEvents, blocked } = args;
  const instruction = run.scheduleId === undefined ? undefined : instructionOf(run.scheduleId);
  const afterInstruction = newestEvents.filter((event) => event.kind !== "scheduleFired");
  return {
    _id: run._id,
    bot: lookOf(bot),
    trigger: run.trigger,
    instruction: instruction === undefined ? null : oneLine(instruction, ROW_TEXT_OVER_TWO_LINES),
    state: publicState(run.state),
    createdAt: run._creationTime,
    endedAt: run.endedAt,
    lastText: lastMessageOf(afterInstruction, ROW_TEXT_OVER_TWO_LINES),
    blocked,
  };
}

function sortKeyOf({ nextFireAt }: { nextFireAt?: number }): number {
  return nextFireAt ?? Number.MAX_SAFE_INTEGER;
}

export function upcomingRows(args: { routines: readonly UpcomingRoutine[]; botOf: (botId: Id<"bots">) => BotLook | undefined; timeZone: string }) {
  const { routines, botOf, timeZone } = args;
  return routines
    .flatMap((routine) => {
      const bot = botOf(routine.botId);
      return bot === undefined
        ? []
        : [
            {
              _id: routine._id,
              bot: lookOf(bot),
              instruction: oneLine(routine.instruction, ROW_TEXT_OVER_TWO_LINES),
              when: describeCadence(routine.cadence, timeZone),
              nextFireAt: routine.nextFireAt,
              pausedBecause: routine.pausedBecause,
              lastMissed: routine.lastMissed,
            },
          ];
    })
    .toSorted((a, b) => sortKeyOf(a) - sortKeyOf(b));
}

type ActivityPage = {
  timeZone: string;
  upcoming: ReturnType<typeof upcomingRows>;
  runs: ReturnType<typeof runRow>[];
};

export const page = query({
  args: {},
  handler: async (ctx): Promise<ActivityPage> => {
    const { user } = await requireIdentity(ctx);
    if (user === null) {
      return { timeZone: FALLBACK_ZONE, upcoming: [], runs: [] };
    }
    const bots = new Map<string, Doc<"bots">>();
    for await (const bot of ctx.db.query("bots").withIndex("by_owner", (q) => q.eq("ownerId", user._id))) {
      bots.set(bot._id, bot);
    }
    const routines = await ctx.db
      .query("schedules")
      .withIndex("by_owner", (q) => q.eq("ownerId", user._id))
      .collect();
    const instructions = new Map<string, string>(routines.map((routine) => [routine._id, routine.instruction]));
    const botOf = (botId: Id<"bots">) => bots.get(botId);
    const listed = [];
    let scanned = 0;
    for await (const run of ctx.db
      .query("runs")
      .withIndex("by_owner", (q) => q.eq("ownerId", user._id))
      .order("desc")) {
      scanned += 1;
      const listing = listingOf(run, botOf);
      if (listing !== null) {
        listed.push(listing);
      }
      if (listed.length === LISTED_RUNS || scanned === MAX_RUNS_SCANNED) {
        break;
      }
    }
    const budget = { bytes: TEXT_READ_BYTES };
    // A model chooses a rejected call's name, up to 256 KiB, so 50 of these can reach the read limit unless they count.
    const blocked = new Set<string>();
    for (const { run } of listed) {
      const rejected = await ctx.db
        .query("runEvents")
        .withIndex("by_run_outcome", (q) => q.eq("runId", run._id).eq("body.outcome", "rejected"))
        .first();
      if (rejected !== null) {
        budget.bytes -= bytesOf(rejected);
        blocked.add(run._id);
      }
    }
    const runs = [];
    for (const { run, bot } of listed) {
      runs.push(
        runRow({
          run,
          bot,
          instructionOf: (scheduleId) => instructions.get(scheduleId),
          newestEvents: await newestEventsUpToText(ctx, run._id, budget),
          blocked: blocked.has(run._id),
        }),
      );
    }
    const timeZone = user.timeZone ?? FALLBACK_ZONE;
    return { timeZone, upcoming: upcomingRows({ routines, botOf, timeZone }), runs };
  },
});
