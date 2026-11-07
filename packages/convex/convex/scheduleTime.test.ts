import { describe, expect, it } from "vitest";
import { describeCadence, isTimeZone, nextFireAfter, parseCadence } from "./scheduleTime.js";
import type { Cadence } from "./validators.js";

const weekly = (weekdays: number[], hour: number, minute: number): Cadence => ({ kind: "weekly", weekdays, hour, minute });
const local = (at: number, timeZone: string) => new Intl.DateTimeFormat("sv-SE", { timeZone, dateStyle: "short", timeStyle: "short" }).format(at);
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
const HOUR = 3_600_000;

describe("describeCadence", () => {
  it.each<[Cadence, string]>([
    [weekly([1], 9, 0), "Every Monday at 09:00, Europe/Stockholm time"],
    [weekly([4, 1], 7, 5), "Every Monday and Thursday at 07:05, Europe/Stockholm time"],
    [weekly([5, 1, 3], 18, 30), "Every Monday, Wednesday, and Friday at 18:30, Europe/Stockholm time"],
    [weekly([0, 6], 12, 0), "Every Saturday and Sunday at 12:00, Europe/Stockholm time"],
    [weekly([5, 4, 3, 2, 1], 8, 0), "Every weekday at 08:00, Europe/Stockholm time"],
    [weekly(EVERY_DAY, 23, 59), "Every day at 23:59, Europe/Stockholm time"],
    [{ kind: "everyHours", hours: 1 }, "Every hour"],
    [{ kind: "everyHours", hours: 6 }, "Every 6 hours"],
  ])("words %j", (cadence, words) => {
    expect(describeCadence(cadence, "Europe/Stockholm")).toBe(words);
  });

  it("writes a zone's name with spaces", () => {
    expect(describeCadence(weekly([2], 9, 0), "America/New_York")).toBe("Every Tuesday at 09:00, America/New York time");
  });
});

describe("parseCadence", () => {
  it.each<[unknown]>([[weekly([1, 3], 9, 0)], [weekly(EVERY_DAY, 23, 59)], [{ kind: "everyHours", hours: 1 }], [{ kind: "everyHours", hours: 24 }]])("accepts %j", (value) => {
    expect(parseCadence(value)).toEqual(value);
  });

  it.each<[unknown]>([
    [null],
    ["weekly"],
    [{ kind: "monthly" }],
    [weekly([], 9, 0)],
    [weekly([7], 9, 0)],
    [weekly([-1], 9, 0)],
    [weekly([1.5], 9, 0)],
    [weekly([1, 1], 9, 0)],
    [weekly([1], 24, 0)],
    [weekly([1], 9, 60)],
    [{ kind: "weekly", weekdays: [1], hour: 9 }],
    [{ kind: "everyHours", hours: 0 }],
    [{ kind: "everyHours", hours: 0.5 }],
    [{ kind: "everyHours", hours: 25 }],
    [{ kind: "everyHours", hours: "6" }],
  ])("refuses %j", (value) => {
    expect(parseCadence(value)).toBeNull();
  });
});

describe("isTimeZone", () => {
  it("tells a zone from a name that is not one", () => {
    expect(isTimeZone("Europe/Stockholm")).toBe(true);
    expect(isTimeZone("Asia/Kolkata")).toBe(true);
    expect(isTimeZone("Bogus/Zone")).toBe(false);
    expect(isTimeZone("")).toBe(false);
  });
});

describe("nextFireAfter", () => {
  it("counts every so many hours from the given moment, in any zone", () => {
    expect(nextFireAfter({ kind: "everyHours", hours: 6 }, "Asia/Tokyo", 1000)).toBe(1000 + 6 * HOUR);
  });

  it("finds the next listed weekday at the owner's wall time", () => {
    const saturday = Date.UTC(2026, 10, 7, 12);
    expect(local(nextFireAfter(weekly([1], 9, 0), "Europe/Stockholm", saturday), "Europe/Stockholm")).toBe("2026-11-09 09:00");
    expect(local(nextFireAfter(weekly([1], 9, 0), "America/New_York", saturday), "America/New_York")).toBe("2026-11-09 09:00");
  });

  it("uses today when its time is still ahead, and not when that moment has passed", () => {
    const zone = "UTC";
    const saturdayMorning = Date.UTC(2026, 10, 7, 8);
    const at = nextFireAfter(weekly([6], 9, 0), zone, saturdayMorning);
    expect(at).toBe(Date.UTC(2026, 10, 7, 9));
    expect(nextFireAfter(weekly([6], 9, 0), zone, at)).toBe(Date.UTC(2026, 10, 14, 9));
  });

  it("fires a skipped local time once, on its day, at the instant the clock moved past it", () => {
    const at = nextFireAfter(weekly([0], 2, 30), "America/New_York", Date.UTC(2027, 2, 13));
    expect(local(at, "America/New_York")).toBe("2027-03-14 03:30");
    expect(local(nextFireAfter(weekly([0], 2, 30), "America/New_York", at + 45_000), "America/New_York")).toBe("2027-03-21 02:30");
  });

  it("fires a repeated local time once, at its earlier instant", () => {
    const at = nextFireAfter(weekly([0], 1, 30), "America/New_York", Date.UTC(2027, 10, 6));
    expect(at).toBe(Date.UTC(2027, 10, 7, 5, 30));
    expect(local(nextFireAfter(weekly([0], 1, 30), "America/New_York", at + 45_000), "America/New_York")).toBe("2027-11-14 01:30");
  });

  it("handles a half-hour change of clock", () => {
    expect(local(nextFireAfter(weekly([0], 2, 15), "Australia/Lord_Howe", Date.UTC(2027, 9, 2)), "Australia/Lord_Howe")).toBe("2027-10-03 02:45");
  });

  it.each(["Europe/Stockholm", "America/New_York", "America/Havana", "Asia/Beirut", "Australia/Lord_Howe", "Pacific/Apia", "Asia/Kathmandu", "UTC"])(
    "in %s, a daily routine fires once on each local date across 14 months",
    (zone) => {
      const dateOf = (at: number) => new Intl.DateTimeFormat("en-CA", { timeZone: zone, dateStyle: "short" }).format(at);
      for (const [hour, minute] of [[0, 0], [0, 30], [2, 30], [23, 30]] as const) {
        const start = Date.UTC(2026, 10, 7);
        const end = Date.UTC(2028, 0, 1);
        const seen = new Set<string>();
        let at = start;
        while (at < end) {
          const next = nextFireAfter(weekly(EVERY_DAY, hour, minute), zone, at);
          const date = dateOf(next);
          expect(seen.has(date), `${zone} ${hour}:${minute} fired twice on ${date}`).toBe(false);
          seen.add(date);
          at = next + 45_000;
        }
        for (let day = start + 2 * 86_400_000; day < end - 2 * 86_400_000; day += 86_400_000) {
          const date = new Date(day).toISOString().slice(0, 10);
          expect(seen.has(date), `${zone} ${hour}:${minute} missed ${date}`).toBe(true);
        }
      }
    },
  );

  it("throws for a weekly cadence with no day, which parseCadence never lets through", () => {
    expect(() => nextFireAfter(weekly([], 9, 0), "UTC", 0)).toThrow(/weekday/);
  });
});
