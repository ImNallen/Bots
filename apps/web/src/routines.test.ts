import { describe, expect, it } from "vitest";
import { nextRunLabel, routineStatus, runStateWords } from "./routines.ts";

const NOW = Date.UTC(2026, 10, 7, 12);
const context = { now: NOW, timeZone: "Europe/Stockholm", locale: "en-GB" };

describe("nextRunLabel", () => {
  it("names the day and time in the owner's zone, not the device's", () => {
    const at = Date.UTC(2026, 10, 9, 8);
    expect(nextRunLabel({ at, now: NOW, timeZone: "Europe/Stockholm", locale: "en-GB" })).toMatch(/Mon.*9 Nov.*\b9:00/);
    expect(nextRunLabel({ at, now: NOW, timeZone: "America/New_York", locale: "en-GB" })).toMatch(/Mon.*9 Nov.*\b3:00/);
  });

  it("says a routine is due when its time has passed and it has not fired yet", () => {
    expect(nextRunLabel({ at: NOW - 1000, now: NOW, timeZone: "UTC", locale: "en-GB" })).toBe("Due now");
  });
});

describe("routineStatus", () => {
  it("names the next run", () => {
    expect(routineStatus({ nextFireAt: Date.UTC(2026, 10, 9, 8), pausedBecause: undefined }, context)).toMatch(/^Next run: Mon/);
  });

  it("says a routine the owner paused is paused", () => {
    expect(routineStatus({ nextFireAt: undefined, pausedBecause: undefined }, context)).toBe("Paused");
  });

  it("says why a routine paused itself", () => {
    expect(routineStatus({ nextFireAt: undefined, pausedBecause: "It paused itself after 3 failed runs." }, context)).toBe("Paused. It paused itself after 3 failed runs.");
  });
});

describe("runStateWords", () => {
  it.each([
    [{ kind: "queued" }, "Waiting to start", "plain"],
    [{ kind: "running" }, "Running", "plain"],
    [{ kind: "done" }, "Succeeded", "plain"],
    [{ kind: "failed", reason: "No key." }, "Failed: No key.", "bad"],
    [{ kind: "cancelled" }, "Stopped", "plain"],
  ] as const)("words %j", (state, words, tone) => {
    expect(runStateWords(state)).toEqual({ words, tone });
  });
});
