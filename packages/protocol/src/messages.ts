import { z } from "zod";
import { screenView } from "./desktop.ts";
import { toolInvocation } from "./tools.ts";

// A result carries a picture of the screen, up to MAX_SCREEN_IMAGE_BYTES, and its marks. computerd's fitToLink keeps every result
// under this, and the orchestrator deploys first, so its limit is live before any computerd sends a picture.
export const MAX_COMPUTER_MESSAGE_BYTES = 2 * 1024 * 1024;
export const MAX_ORCHESTRATOR_MESSAGE_BYTES = 8 * 1024 * 1024;

export const LINK_CLOSE = {
  invalidMessage: 1008,
  internalError: 1011,
  replaced: 4000,
  unauthorized: 4001,
  noComputer: 4002,
  tooManyStreams: 4003,
  takeoverEnded: 4004,
} as const;

const SAFE_ID = "[A-Za-z0-9_-]{1,64}";

export const TOOL_CALL_ID = /^[A-Za-z0-9]{9}$/;

const callId = z.string().regex(new RegExp(`^${SAFE_ID}:${SAFE_ID}$`));
const botId = z.string().regex(new RegExp(`^${SAFE_ID}$`));
const streamId = z.string().regex(new RegExp(`^${SAFE_ID}$`));
const browsingKey = z.string().regex(new RegExp(`^${SAFE_ID}$`));

export const browsing = z.strictObject({ kind: z.literal("loggedOut"), key: browsingKey });

export type Browsing = z.infer<typeof browsing>;

// computerd only reports what it can observe. The orchestrator alone records "unavailable" and "invalid".
export const toolResult = z.strictObject({
  outcome: z.enum(["ok", "error", "timeout", "interrupted", "cancelled"]),
  output: z.string(),
  exitCode: z.number().int().optional(),
  truncated: z.boolean(),
  screen: screenView.optional(),
});

export type ToolResult = z.infer<typeof toolResult>;

const LONGEST_CALL_ID = "x".repeat(64 * 2 + 1);
const PICTURE_DROPPED = "The picture of the screen was too large to send, so this look has none.";

function messageBytes(result: ToolResult): number {
  return Buffer.byteLength(JSON.stringify({ kind: "toolResult", callId: LONGEST_CALL_ID, result }));
}

// computerd calls this before it journals a result. A frame over the limit would close the link, and the call sent again would
// get the same answer from the journal at every reconnect.
export function fitToLink(result: ToolResult): ToolResult {
  if (result.screen === undefined || messageBytes(result) <= MAX_COMPUTER_MESSAGE_BYTES) {
    return result;
  }
  const { image: _image, ...view } = result.screen;
  let fitted: ToolResult = { ...result, output: `${result.output}\n${PICTURE_DROPPED}`, screen: view };
  while (fitted.screen !== undefined && fitted.screen.marks.length > 0 && messageBytes(fitted) > MAX_COMPUTER_MESSAGE_BYTES) {
    const marks = fitted.screen.marks.slice(0, Math.floor(fitted.screen.marks.length / 2));
    fitted = { ...fitted, screen: { ...fitted.screen, marks, unlisted: fitted.screen.unlisted + fitted.screen.marks.length - marks.length } };
  }
  return fitted;
}

// The journal keeps results for days, so it keeps no picture of the screen. A repeated call gets the marks and no picture.
export function withoutScreenImage(result: ToolResult): ToolResult {
  if (result.screen?.image === undefined) {
    return result;
  }
  const { image: _image, ...view } = result.screen;
  return { ...result, screen: view };
}

// Every computerd accepted exactly these before hello named its tools. This is history, so it never changes.
export const TOOLS_BEFORE_ANNOUNCEMENT: readonly string[] = [
  "shell",
  "read_file",
  "write_file",
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_press",
];

export const computerMessage = z.discriminatedUnion("kind", [
  // A computerd older than the announcement sends no tools.
  z.strictObject({ kind: z.literal("hello"), token: z.string().min(1).max(512), tools: z.array(z.string().max(64)).max(64).optional() }),
  z.strictObject({ kind: z.literal("toolResult"), callId, result: toolResult }),
  z.strictObject({ kind: z.literal("streamHello"), token: z.string().min(1).max(512), streamId }),
]);

export type ComputerMessage = z.infer<typeof computerMessage>;

// A person watches a stream, or uses it during a take-over.
export type StreamMode = "watch" | "control";

export const orchestratorMessage = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("welcome") }),
  z.strictObject({ kind: z.literal("toolCall"), callId, botId, tool: toolInvocation, browsing: browsing.optional() }),
  z.strictObject({ kind: z.literal("browsingEnd"), botId, key: browsingKey }),
  z.strictObject({ kind: z.literal("cancelTool"), callId }),
  // Only control carries a mode. A computerd closes its link on a field it does not know, and a VM updates after its orchestrator,
  // so a watch stream's message must stay what it was before modes.
  z.strictObject({ kind: z.literal("screenOpen"), streamId, botId, mode: z.literal("control").optional() }),
]);

export type OrchestratorMessage = z.infer<typeof orchestratorMessage>;

export function makeCallId(args: { runId: string; toolCallId: string }): string {
  return `${args.runId}:${args.toolCallId}`;
}

// A callId names journal files, and a parsed callId is safe in base64url however it was written.
export function callIdToFileStem(id: string): string {
  return Buffer.from(callId.parse(id), "utf8").toString("base64url");
}

export function parseJsonMessage<T>(args: { raw: string; schema: z.ZodType<T> }): T | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(args.raw);
  } catch {
    return null;
  }
  const result = args.schema.safeParse(parsed);
  return result.success ? result.data : null;
}
