import { v, type Infer } from "convex/values";

export const toolCall = v.object({
  id: v.string(),
  name: v.string(),
  arguments: v.string(),
});

export const runEventBody = v.union(
  v.object({ kind: v.literal("userMessage"), text: v.string() }),
  v.object({
    kind: v.literal("assistantTurn"),
    text: v.string(),
    reasoning: v.optional(v.string()),
    toolCalls: v.array(toolCall),
    usage: v.object({ promptTokens: v.number(), completionTokens: v.number() }),
    model: v.string(),
  }),
  v.object({
    kind: v.literal("toolResult"),
    toolCallId: v.string(),
    name: v.string(),
    outcome: v.union(
      v.literal("ok"),
      v.literal("error"),
      v.literal("timeout"),
      v.literal("interrupted"),
      v.literal("unavailable"),
      v.literal("invalid"),
      v.literal("cancelled"),
      v.literal("denied"),
    ),
    output: v.string(),
    exitCode: v.optional(v.number()),
    truncated: v.boolean(),
  }),
);

export const terminalRunState = v.union(
  v.object({ kind: v.literal("done") }),
  v.object({ kind: v.literal("failed"), reason: v.string() }),
  v.object({ kind: v.literal("cancelled") }),
);

export const runState = v.union(
  v.object({ kind: v.literal("queued") }),
  v.object({ kind: v.literal("running"), leaseToken: v.string(), leaseUntil: v.number() }),
  terminalRunState,
);

export type RunState = Infer<typeof runState>;

export const desiredVm = v.object({
  slot: v.number(),
  cores: v.number(),
  memoryMb: v.number(),
  diskGb: v.number(),
  removing: v.boolean(),
});

export const observedVm = v.object({
  stage: v.string(),
  detail: v.optional(v.string()),
  at: v.number(),
});

export const approvalLevel = v.union(v.literal("everything"), v.literal("outside"), v.literal("shell"), v.literal("nothing"));
export type ApprovalLevel = Infer<typeof approvalLevel>;

export const approvalState = v.union(v.literal("pending"), v.literal("approved"), v.literal("denied"), v.literal("expired"));
