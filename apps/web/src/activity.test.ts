import { describe, expect, it } from "vitest";
import { shownActivity, subLineOf } from "./activity.ts";

const lastMessage = "See you tomorrow.";

describe("a row during a take-over", () => {
  const until = 1_000_000;
  const row = { activity: { kind: "idle" } as const, takeoverUntil: until, lastMessage };
  const textAt = (now: number) => subLineOf({ activity: shownActivity(row, now), lastMessage }).text;

  it("says the owner has the screen until the end time, and goes back to the bot's state at that moment", () => {
    expect(textAt(until - 1)).toBe("You have the screen");
    expect(textAt(until)).toBe(lastMessage);
    expect(textAt(until + 1)).toBe(lastMessage);
  });

  it("puts the screen before an approval and shows the approval once the take-over ends", () => {
    const asking = { activity: { kind: "needsApproval" } as const, takeoverUntil: until };
    expect(shownActivity(asking, until - 1)).toEqual({ kind: "ownerHasScreen" });
    expect(shownActivity(asking, until)).toEqual({ kind: "needsApproval" });
  });

  it("shows the bot's own state with no take-over", () => {
    expect(shownActivity({ activity: { kind: "failed" }, takeoverUntil: null }, until)).toEqual({ kind: "failed" });
  });
});

describe("subLineOf", () => {
  it("prefers the state of the bot over its last message", () => {
    expect(subLineOf({ activity: { kind: "needsApproval" }, lastMessage }).text).toBe("Needs your approval");
    expect(subLineOf({ activity: { kind: "ownerHasScreen" }, lastMessage }).text).toBe("You have the screen");
    expect(subLineOf({ activity: { kind: "failed" }, lastMessage }).text).toBe("Stopped with an error");
  });

  it("shows the last message when the bot is idle or queued", () => {
    expect(subLineOf({ activity: { kind: "idle" }, lastMessage }).text).toBe(lastMessage);
    expect(subLineOf({ activity: { kind: "queued" }, lastMessage }).text).toBe(lastMessage);
    expect(subLineOf({ activity: { kind: "idle" }, lastMessage: null }).text).toBeNull();
  });

  it("shows a last message as plain text, not markdown", () => {
    const text = (message: string) => subLineOf({ activity: { kind: "idle" }, lastMessage: message }).text;
    expect(text("## Train options I found **three** in `trains.md`")).toBe("Train options I found three in trains.md");
    expect(text("See the [booking page](https://e.example/a) and ![chart](https://e.example/c.png)")).toBe(
      "See the booking page and chart",
    );
    expect(text("- first item 2 * 3")).toBe("first item 2 * 3");
    expect(text("1. first")).toBe("first");
  });

  it("turns a tool into a friendly step and never shows a raw tool name", () => {
    const step = (tool: string | null) => subLineOf({ activity: { kind: "running", tool }, lastMessage }).text;
    expect(step("shell")).toBe("Running a command");
    expect(step(null)).toBe("Thinking");
    expect(step("a_tool_from_later")).toBe("Working");
    expect(step("constructor")).toBe("Working");
  });
});
