import type { api } from "@bots/convex";
import type { FunctionReturnType } from "convex/server";

export type RoutineRow = NonNullable<FunctionReturnType<typeof api.schedules.listForBot>>["routines"][number];
export type Routine = Extract<RoutineRow, { kind: "live" }>;
export type DeletedRoutine = Extract<RoutineRow, { kind: "deleted" }>;
type RunShown = Routine["recentRuns"][number];

export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function nextRunLabel(args: { at: number; now: number; timeZone: string; locale: string }): string {
  const { at, now, timeZone, locale } = args;
  return at <= now
    ? "Due now"
    : new Intl.DateTimeFormat(locale, { timeZone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(at);
}

export function routineStatus(routine: Pick<Routine, "nextFireAt" | "pausedBecause">, args: { now: number; timeZone: string; locale: string }): string {
  if (routine.pausedBecause !== undefined) {
    return `Paused. ${routine.pausedBecause}`;
  }
  return routine.nextFireAt === undefined ? "Paused" : `Next run: ${nextRunLabel({ at: routine.nextFireAt, ...args })}`;
}

// The line under the schedule in a routine's details. That schedule leaves out the zone, so this line names it.
export function nextRunLine(routine: Pick<Routine, "nextFireAt" | "pausedBecause">, args: { now: number; timeZone: string; locale: string }): string {
  if (routine.nextFireAt === undefined) {
    return routineStatus(routine, args);
  }
  return `Next run ${nextRunLabel({ at: routine.nextFireAt, ...args })} · ${args.timeZone.replaceAll("_", " ")}`;
}

// A deleted routine's undo line shows until its window ends, and a line whose window has ended is gone even before the server says so.
export function shownRoutines(rows: readonly RoutineRow[], now: number): RoutineRow[] {
  return rows.filter((row) => row.kind === "live" || row.deletingUntil > now);
}

export function runStateWords({ state, quiet }: Pick<RunShown, "state" | "quiet">): { words: string; tone: "plain" | "bad" } {
  switch (state.kind) {
    case "queued":
      return { words: "Waiting to start", tone: "plain" };
    case "running":
      return { words: "Running", tone: "plain" };
    case "done":
      return { words: quiet ? "Nothing to report" : "Succeeded", tone: "plain" };
    case "failed":
      return { words: `Failed: ${state.reason}`, tone: "bad" };
    case "cancelled":
      return { words: "Stopped", tone: "plain" };
  }
}
