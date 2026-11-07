import { parseCadence } from "@bots/convex/scheduleTime";
import { parseToolCall } from "@bots/protocol";
import { describe, expect, it } from "vitest";

const parsedByTool = (cadence: unknown) => parseToolCall({ name: "schedule_propose", arguments: JSON.stringify({ instruction: "Read the news.", cadence }) }).kind === "ok";

describe("a cadence, in the tool's schema and in the backend's rule", () => {
  it.each<[unknown]>([
    [{ kind: "weekly", weekdays: [0], hour: 0, minute: 0 }],
    [{ kind: "weekly", weekdays: [0, 1, 2, 3, 4, 5, 6], hour: 23, minute: 59 }],
    [{ kind: "everyHours", hours: 1 }],
    [{ kind: "everyHours", hours: 24 }],
  ])("both accept %j", (cadence) => {
    expect(parsedByTool(cadence)).toBe(true);
    expect(parseCadence(cadence)).toEqual(cadence);
  });

  it.each<[unknown]>([
    [{ kind: "weekly", weekdays: [], hour: 9, minute: 0 }],
    [{ kind: "weekly", weekdays: [7], hour: 9, minute: 0 }],
    [{ kind: "weekly", weekdays: [1.5], hour: 9, minute: 0 }],
    [{ kind: "weekly", weekdays: [1, 1], hour: 9, minute: 0 }],
    [{ kind: "weekly", weekdays: [1], hour: 24, minute: 0 }],
    [{ kind: "weekly", weekdays: [1], hour: 9, minute: 60 }],
    [{ kind: "weekly", weekdays: [1], hour: 9 }],
    [{ kind: "everyHours", hours: 0 }],
    [{ kind: "everyHours", hours: 0.5 }],
    [{ kind: "everyHours", hours: 25 }],
    [{ kind: "monthly", day: 1 }],
    ["daily"],
  ])("both refuse %j", (cadence) => {
    expect(parsedByTool(cadence)).toBe(false);
    expect(parseCadence(cadence)).toBeNull();
  });

  it("gives the runner the cadence and the instruction, and nothing more", () => {
    const cadence = { kind: "everyHours", hours: 6 };
    expect(parseToolCall({ name: "schedule_propose", arguments: JSON.stringify({ instruction: "x", cadence }) })).toEqual({
      kind: "ok",
      invocation: { name: "schedule_propose", args: { instruction: "x", cadence } },
    });
    expect(parseToolCall({ name: "schedule_propose", arguments: JSON.stringify({ instruction: "x", cadence, description: "every Monday" }) }).kind).toBe("invalid");
  });
});
