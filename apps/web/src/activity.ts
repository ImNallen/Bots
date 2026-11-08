import type { api } from "@bots/convex";
import type { FunctionReturnType } from "convex/server";
import type { ToolName } from "@bots/protocol";
import { useEffect, useState } from "react";
import type { FaceState } from "./BotFace.tsx";

export type BotRow = FunctionReturnType<typeof api.bots.overview>[number];
type RowState = Pick<BotRow, "activity" | "takeoverUntil">;
export type ShownActivity = BotRow["activity"] | { kind: "ownerHasScreen" };

export const FACE_STATES: Record<ShownActivity["kind"], FaceState> = {
  idle: "idle",
  queued: "idle",
  running: "working",
  needsApproval: "needsApproval",
  ownerHasScreen: "held",
  failed: "error",
};

export function faceStateFor(activity: ShownActivity): FaceState {
  return activity.kind === "running" ? activity.tool === null ? "thinking" : "working" : FACE_STATES[activity.kind];
}

const THINKING = "Thinking";
const WORKING = "Working";

export const TOOL_STEPS: Record<ToolName, string> = {
  shell: "Running a command",
  read_file: "Reading a file",
  write_file: "Saving a file",
  browser_navigate: "Opening a page",
  browser_snapshot: "Reading the page",
  browser_click: "Clicking on the page",
  browser_type: "Typing on the page",
  browser_press: "Pressing a key",
  memory_save: "Saving a note",
  memory_forget: "Forgetting a note",
  description_set: "Updating its description",
  schedule_propose: "Proposing a routine",
};

export function isToolName(tool: string): tool is ToolName {
  return Object.hasOwn(TOOL_STEPS, tool);
}

export function friendlyStep(tool: string | null): string {
  if (tool === null) {
    return THINKING;
  }
  return isToolName(tool) ? TOOL_STEPS[tool] : WORKING;
}

// The list shows one line of plain text, and a bot's last message is markdown that has already lost its line breaks.
export function withoutMarkdown(message: string): string {
  return message
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^(#{1,6}|>|[-*+]|\d+[.)])\s+/, "")
    .replace(/\*\*|__|~~|`/g, "");
}

export type SubLine = { text: string | null; tone: "plain" | "ask" | "bad" };

export function shownActivity({ activity, takeoverUntil }: RowState, now: number): ShownActivity {
  return takeoverUntil !== null && takeoverUntil > now ? { kind: "ownerHasScreen" } : activity;
}

// A timer in a sleeping phone can stop with the phone, so waking it checks the time as well.
export function useShownActivity(row: RowState): ShownActivity {
  const { takeoverUntil } = row;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (takeoverUntil === null) {
      return undefined;
    }
    const check = () => setNow(Date.now());
    // Never less than the end time, because a timer can fire a moment early and no second one would follow.
    const timer = setTimeout(() => setNow(Math.max(Date.now(), takeoverUntil)), Math.max(0, takeoverUntil - Date.now()));
    document.addEventListener("visibilitychange", check);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", check);
    };
  }, [takeoverUntil]);
  return shownActivity(row, now);
}

export function subLineOf({ activity, lastMessage }: { activity: ShownActivity; lastMessage: string | null }): SubLine {
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
      return { text: lastMessage === null ? null : withoutMarkdown(lastMessage), tone: "plain" };
  }
}
