import type { api } from "@bots/convex";
import type { FunctionReturnType } from "convex/server";

export type Routine = NonNullable<FunctionReturnType<typeof api.schedules.listForBot>>["routines"][number];
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

export function runStateWords(state: RunShown["state"]): { words: string; tone: "plain" | "bad" } {
  switch (state.kind) {
    case "queued":
      return { words: "Waiting to start", tone: "plain" };
    case "running":
      return { words: "Running", tone: "plain" };
    case "done":
      return { words: "Succeeded", tone: "plain" };
    case "failed":
      return { words: `Failed: ${state.reason}`, tone: "bad" };
    case "cancelled":
      return { words: "Stopped", tone: "plain" };
  }
}
