import { describe, expect, it } from "vitest";
import { subLineOf } from "./activity.ts";

const lastMessage = "See you tomorrow.";

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

  it("turns a tool into a friendly step and never shows a raw tool name", () => {
    const step = (tool: string | null) => subLineOf({ activity: { kind: "running", tool }, lastMessage }).text;
    expect(step("shell")).toBe("Running a command");
    expect(step(null)).toBe("Thinking");
    expect(step("a_tool_from_later")).toBe("Working");
    expect(step("constructor")).toBe("Working");
  });
});
