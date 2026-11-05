import { z } from "zod";
import { OUTPUT_CAP_BYTES } from "./output.ts";
import { toolInvocation } from "./tools.ts";

// JSON escaping can expand each output byte to six, so these limits sit above the output cap.
export const MAX_COMPUTER_MESSAGE_BYTES = OUTPUT_CAP_BYTES * 8;
export const MAX_ORCHESTRATOR_MESSAGE_BYTES = 8 * 1024 * 1024;

export const LINK_CLOSE = {
  invalidMessage: 1008,
  internalError: 1011,
  replaced: 4000,
  unauthorized: 4001,
  noComputer: 4002,
  tooManyStreams: 4003,
} as const;

const SAFE_ID = "[A-Za-z0-9_-]{1,64}";

export const TOOL_CALL_ID = /^[A-Za-z0-9]{9}$/;

const callId = z.string().regex(new RegExp(`^${SAFE_ID}:${SAFE_ID}$`));
const botId = z.string().regex(new RegExp(`^${SAFE_ID}$`));
const streamId = z.string().regex(new RegExp(`^${SAFE_ID}$`));

// computerd only reports what it can observe. The orchestrator alone records "unavailable" and "invalid".
export const toolResult = z.strictObject({
  outcome: z.enum(["ok", "error", "timeout", "interrupted", "cancelled"]),
  output: z.string(),
  exitCode: z.number().int().optional(),
  truncated: z.boolean(),
});

export type ToolResult = z.infer<typeof toolResult>;

export const computerMessage = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("hello"), token: z.string().min(1).max(512) }),
  z.strictObject({ kind: z.literal("toolResult"), callId, result: toolResult }),
  z.strictObject({ kind: z.literal("streamHello"), token: z.string().min(1).max(512), streamId }),
]);

export type ComputerMessage = z.infer<typeof computerMessage>;

export const orchestratorMessage = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("welcome") }),
  z.strictObject({ kind: z.literal("toolCall"), callId, botId, tool: toolInvocation }),
  z.strictObject({ kind: z.literal("cancelTool"), callId }),
  z.strictObject({ kind: z.literal("screenOpen"), streamId, botId }),
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
