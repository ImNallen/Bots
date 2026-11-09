import { v, type Infer } from "convex/values";

export const toolCall = v.object({
  id: v.string(),
  name: v.string(),
  arguments: v.string(),
});

export const attachmentContentType = v.union(v.literal("image/png"), v.literal("image/jpeg"), v.literal("image/webp"), v.literal("application/pdf"), v.literal("text/plain"));
export const messageAttachment = v.object({
  id: v.id("attachments"), name: v.string(), contentType: attachmentContentType, size: v.number(),
});

export const runTrigger = v.union(v.literal("user"), v.literal("schedule"));
export const runCapability = v.union(v.literal("full"), v.literal("readOnly"));

const toolResultFields = {
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
    v.literal("rejected"),
  ),
  output: v.string(),
  exitCode: v.optional(v.number()),
  truncated: v.boolean(),
};

export const runEventBody = v.union(
  v.object({ kind: v.literal("userMessage"), text: v.string(), attachments: v.optional(v.array(messageAttachment)) }),
  v.object({ kind: v.literal("scheduleFired"), scheduleId: v.id("schedules"), text: v.string() }),
  v.object({ kind: v.literal("routineReport"), scheduleId: v.id("schedules"), runId: v.id("runs"), text: v.string() }),
  v.object({
    kind: v.literal("assistantTurn"),
    text: v.string(),
    reasoning: v.optional(v.string()),
    toolCalls: v.array(toolCall),
    usage: v.object({ promptTokens: v.number(), completionTokens: v.number() }),
    model: v.string(),
  }),
  v.object(toolResultFields),
);

export const screenBox = v.object({ x: v.number(), y: v.number(), w: v.number(), h: v.number() });
export const screenImageBytes = v.object({ mediaType: v.union(v.literal("image/png"), v.literal("image/jpeg")), bytes: v.bytes() });
// view is a @bots/protocol screenView without its image, as JSON. Only the orchestrator reads it, through that schema.
export const keptScreen = v.object({ view: v.string(), image: v.optional(screenImageBytes) });
export type KeptScreen = Infer<typeof keptScreen>;
// Only append takes this. A stored toolResult never holds a screen, because the screens row does.
export const toolResultWithScreen = v.object({ ...toolResultFields, screen: keptScreen });

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
export type TerminalRunState = Infer<typeof terminalRunState>;
export type RunEventBody = Infer<typeof runEventBody>;

export const noteSource = v.union(
  v.object({ kind: v.literal("owner") }),
  v.object({ kind: v.literal("bot"), runId: v.id("runs") }),
);

export const memoryCall = v.union(
  v.object({ kind: v.literal("memorySave"), toolCallId: v.string(), text: v.string() }),
  v.object({ kind: v.literal("memoryForget"), toolCallId: v.string(), noteId: v.string() }),
  v.object({ kind: v.literal("descriptionSet"), toolCallId: v.string(), text: v.string() }),
);

export type MemoryCall = Infer<typeof memoryCall>;

export const cadence = v.union(
  v.object({ kind: v.literal("weekly"), weekdays: v.array(v.number()), hour: v.number(), minute: v.number() }),
  v.object({ kind: v.literal("everyHours"), hours: v.number() }),
);

export type Cadence = Infer<typeof cadence>;

export const scheduleCreate = v.object({ kind: v.literal("scheduleCreate"), toolCallId: v.string(), instruction: v.string(), cadence });

export type ScheduleCreate = Infer<typeof scheduleCreate>;

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

export const approvalLevel = v.union(v.literal("everything"), v.literal("outside"), v.literal("shell"), v.literal("nothing"), v.literal("automatic"));
export type ApprovalLevel = Infer<typeof approvalLevel>;

export const approvalState = v.union(v.literal("pending"), v.literal("approved"), v.literal("denied"), v.literal("expired"));

export const botShape = v.union(
  v.literal("ball"),
  v.literal("bun"),
  v.literal("tile"),
  v.literal("sparkle"),
  v.literal("clover"),
  v.literal("heart"),
  v.literal("flower"),
  v.literal("egg"),
  v.literal("bean"),
  v.literal("peak"),
  v.literal("gem"),
  v.literal("burst"),
  v.literal("hex"),
);

export const botColor = v.union(
  v.literal("black"),
  v.literal("brown"),
  v.literal("red"),
  v.literal("orange"),
  v.literal("amber"),
  v.literal("green"),
  v.literal("teal"),
  v.literal("blue"),
  v.literal("purple"),
  v.literal("pink"),
  v.literal("grey"),
);
