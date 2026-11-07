import type { Cadence } from "./validators.js";

export const MIN_EVERY_HOURS = 1;
export const MAX_EVERY_HOURS = 24;
export const FALLBACK_ZONE = "UTC";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKDAY_NUMBER: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const MONDAY_FIRST = [1, 2, 3, 4, 5, 6, 0];
const WORK_WEEK = [1, 2, 3, 4, 5];
const WEEK_PLUS_A_REPEATED_DATE = 8;

function isWhole(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

export function parseCadence(value: unknown): Cadence | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const fields = value as Record<string, unknown>;
  switch (fields.kind) {
    case "weekly": {
      const { weekdays, hour, minute } = fields;
      const valid =
        Array.isArray(weekdays) &&
        weekdays.length > 0 &&
        weekdays.every((day) => isWhole(day, 0, 6)) &&
        new Set(weekdays).size === weekdays.length &&
        isWhole(hour, 0, 23) &&
        isWhole(minute, 0, 59);
      return valid ? { kind: "weekly", weekdays: weekdays as number[], hour: hour as number, minute: minute as number } : null;
    }
    case "everyHours":
      return isWhole(fields.hours, MIN_EVERY_HOURS, MAX_EVERY_HOURS) ? { kind: "everyHours", hours: fields.hours } : null;
    default:
      return null;
  }
}

function listOf(names: readonly string[]): string {
  const last = names.at(-1) ?? "";
  if (names.length < 2) {
    return last;
  }
  const rest = names.slice(0, -1).join(", ");
  return names.length === 2 ? `${rest} and ${last}` : `${rest}, and ${last}`;
}

function daysInWords(weekdays: readonly number[]): string {
  const days = MONDAY_FIRST.filter((day) => weekdays.includes(day));
  if (days.length === MONDAY_FIRST.length) {
    return "Every day";
  }
  if (days.length === WORK_WEEK.length && WORK_WEEK.every((day) => days.includes(day))) {
    return "Every weekday";
  }
  return `Every ${listOf(days.map((day) => DAY_NAMES[day] ?? ""))}`;
}

const twoDigits = (value: number) => String(value).padStart(2, "0");

export function describeCadence(cadence: Cadence, timeZone: string): string {
  switch (cadence.kind) {
    case "weekly":
      return `${daysInWords(cadence.weekdays)} at ${twoDigits(cadence.hour)}:${twoDigits(cadence.minute)}, ${timeZone.replaceAll("_", " ")} time`;
    case "everyHours":
      return cadence.hours === 1 ? "Every hour" : `Every ${cadence.hours} hours`;
  }
}

export function isTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

function wallClock(at: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    weekday: "short",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(at);
  const field = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    year: Number(field("year")),
    month: Number(field("month")),
    day: Number(field("day")),
    hour: Number(field("hour")),
    minute: Number(field("minute")),
    second: Number(field("second")),
    weekday: WEEKDAY_NUMBER[field("weekday")] ?? 0,
  };
}

function offsetAt(at: number, timeZone: string): number {
  const wall = wallClock(at, timeZone);
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) - Math.floor(at / 1000) * 1000;
}

// A repeated local time gives its earlier instant, so it fires once. A skipped one moves later by the size of the jump.
function instantOf(args: { year: number; month: number; day: number; hour: number; minute: number; timeZone: string }): number {
  const { year, month, day, hour, minute, timeZone } = args;
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const offsets = [offsetAt(wall - DAY_MS, timeZone), offsetAt(wall + DAY_MS, timeZone)];
  const matches = offsets
    .map((offset) => wall - offset)
    .filter((at) => {
      const reads = wallClock(at, timeZone);
      return reads.day === day && reads.hour === hour && reads.minute === minute;
    });
  return matches.length > 0 ? Math.min(...matches) : wall - Math.min(...offsets);
}

export function nextFireAfter(cadence: Cadence, timeZone: string, after: number): number {
  switch (cadence.kind) {
    case "everyHours":
      return after + cadence.hours * HOUR_MS;
    case "weekly": {
      const today = wallClock(after, timeZone);
      for (let ahead = 0; ahead <= WEEK_PLUS_A_REPEATED_DATE; ahead += 1) {
        const date = new Date(Date.UTC(today.year, today.month - 1, today.day + ahead));
        if (cadence.weekdays.includes(date.getUTCDay())) {
          const at = instantOf({
            year: date.getUTCFullYear(),
            month: date.getUTCMonth() + 1,
            day: date.getUTCDate(),
            hour: cadence.hour,
            minute: cadence.minute,
            timeZone,
          });
          if (at > after) {
            return at;
          }
        }
      }
      throw new Error("A weekly cadence needs a weekday");
    }
  }
}
