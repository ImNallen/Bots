import type { api } from "@bots/convex";
import type { FunctionReturnType } from "convex/server";
import type { ToolName } from "@bots/protocol";
import type { FaceState } from "./BotFace.tsx";

export type BotRow = FunctionReturnType<typeof api.bots.overview>[number];
export type BotActivity = BotRow["activity"];

export const FACE_STATES: Record<BotActivity["kind"], FaceState> = {
  idle: "idle",
  queued: "idle",
  running: "working",
  needsApproval: "needsApproval",
  ownerHasScreen: "held",
  failed: "idle",
};

const THINKING = "Thinking";
const WORKING = "Working";

const TOOL_STEPS: Record<ToolName, string> = {
  shell: "Running a command",
  read_file: "Reading a file",
  write_file: "Saving a file",
  browser_navigate: "Opening a page",
  browser_snapshot: "Reading the page",
  browser_click: "Clicking on the page",
  browser_type: "Typing on the page",
  browser_press: "Pressing a key",
};

function isToolName(tool: string): tool is ToolName {
  return Object.hasOwn(TOOL_STEPS, tool);
}

function friendlyStep(tool: string | null): string {
  if (tool === null) {
    return THINKING;
  }
  return isToolName(tool) ? TOOL_STEPS[tool] : WORKING;
}

export type SubLine = { text: string | null; tone: "plain" | "ask" | "bad" };

export function subLineOf({ activity, lastMessage }: Pick<BotRow, "activity" | "lastMessage">): SubLine {
  switch (activity.kind) {
    case "needsApproval":
      return { text: "Needs your approval", tone: "ask" };
    case "running":
      return { text: friendlyStep(activity.tool), tone: "plain" };
    case "ownerHasScreen":
      return { text: "You have the screen", tone: "plain" };
    case "failed":
      return { text: "Stopped with an error", tone: "bad" };
    case "queued":
    case "idle":
      return { text: lastMessage, tone: "plain" };
  }
}
