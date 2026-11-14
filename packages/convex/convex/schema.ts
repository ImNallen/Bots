import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  approvalLevel,
  approvalState,
  attachmentContentType,
  botColor,
  botShape,
  cadence,
  desiredVm,
  modelProvider,
  voiceModel,
  noteSource,
  observedVm,
  runCapability,
  runEventBody,
  runState,
  runTrigger,
  screenBox,
  screenImageBytes,
} from "./validators.js";

export default defineSchema({
  attachments: defineTable({
    ownerId: v.id("users"),
    botId: v.id("bots"),
    name: v.string(),
    contentType: attachmentContentType,
    size: v.number(),
    state: v.union(
      v.object({ kind: v.literal("uploading") }),
      v.object({ kind: v.literal("ready"), storageId: v.id("_storage") }),
      v.object({ kind: v.literal("sent"), storageId: v.id("_storage"), runId: v.id("runs") }),
    ),
  }).index("by_bot_state", ["botId", "state.kind"]),

  users: defineTable({
    authSubject: v.string(),
    email: v.string(),
    displayName: v.string(),
    about: v.optional(v.string()),
    timeZone: v.optional(v.string()),
    highlightedBotIds: v.optional(v.array(v.id("bots"))),
    // The provider whose model every bot of this user answers with. No value means Mistral.
    modelProvider: v.optional(modelProvider),
    // The model that turns this user's voice input into text. No value means Voxtral on Mistral.
    voiceModel: v.optional(voiceModel),
  }).index("by_auth_subject", ["authSubject"]),

  bots: defineTable({
    ownerId: v.id("users"),
    name: v.string(),
    // While this is in the future, the owner controls the bot's screen and the bot starts no tool.
    takeoverUntil: v.optional(v.number()),
    // A bot with no value uses the default, which is "automatic".
    approvalLevel: v.optional(approvalLevel),
    // A bot with no value takes its look from its id.
    shape: v.optional(botShape),
    color: v.optional(botColor),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
  }).index("by_owner", ["ownerId"]),

  memories: defineTable({
    botId: v.id("bots"),
    text: v.string(),
    source: noteSource,
  }).index("by_bot", ["botId"]),

  // A deleted bot whose files may still be on its owner's VM. The reconcile loop removes both.
  removedBots: defineTable({
    ownerId: v.id("users"),
    botId: v.id("bots"),
  }).index("by_owner", ["ownerId"]),

  approvals: defineTable({
    ownerId: v.id("users"),
    botId: v.id("bots"),
    threadId: v.id("threads"),
    runId: v.id("runs"),
    toolCallId: v.string(),
    toolName: v.string(),
    state: approvalState,
    requestedAt: v.number(),
    // A desktop input's card: what it does in words, and the box that the card outlines on the run's newest look.
    subject: v.optional(v.string()),
    box: v.optional(screenBox),
    // One plain sentence from the Automatic rules saying why this call needs a card. Absent at the other levels.
    reason: v.optional(v.string()),
  })
    .index("by_run_call", ["runId", "toolCallId"])
    .index("by_owner_state", ["ownerId", "state"])
    .index("by_thread_state", ["threadId", "state"]),

  computers: defineTable({
    ownerId: v.id("users"),
    // A provisioned computer has no hash until its VM makes a token.
    tokenHash: v.optional(v.string()),
    // Only provisioned computers have these. A dev computer is a local container.
    desiredVm: v.optional(desiredVm),
    reset: v.optional(v.object({ generation: v.number(), requestedAt: v.number() })),
    resetCleanup: v.optional(v.union(
      v.object({ kind: v.literal("runs"), runId: v.optional(v.id("runs")), callIndex: v.number() }),
      v.object({ kind: v.literal("approvals") }),
      v.object({ kind: v.literal("bots"), cursor: v.union(v.string(), v.null()) }),
    )),
    observedVm: v.optional(observedVm),
    computerdCommit: v.optional(v.string()),
    // While this is in the future, no run of this owner can be claimed, because computerd is restarting.
    updateFenceUntil: v.optional(v.number()),
  })
    .index("by_token_hash", ["tokenHash"])
    .index("by_owner", ["ownerId"]),

  credentials: defineTable({
    ownerId: v.id("users"),
    ciphertext: v.string(),
    iv: v.string(),
    tag: v.string(),
    keyVersion: v.number(),
    last4: v.string(),
    // No value means a Mistral key, so the rows from before Together keep their meaning.
    provider: v.optional(v.literal("together")),
  })
    .index("by_owner", ["ownerId"])
    .index("by_owner_and_provider", ["ownerId", "provider"]),

  threads: defineTable({
    botId: v.id("bots"),
    ownerId: v.id("users"),
    kind: v.optional(v.literal("routine")),
  }).index("by_bot", ["botId", "kind"]),

  schedules: defineTable({
    ownerId: v.id("users"),
    botId: v.id("bots"),
    threadId: v.id("threads"),
    instruction: v.string(),
    // Optional only because routines made before them have none. Every new or changed routine has all three.
    title: v.optional(v.string()),
    summary: v.optional(v.string()),
    steps: v.optional(v.array(v.string())),
    cadence,
    // Absent means paused.
    nextFireAt: v.optional(v.number()),
    pausedBecause: v.optional(v.string()),
    resumedAt: v.optional(v.number()),
    lastMissed: v.optional(v.object({ at: v.number(), reason: v.string() })),
    // Present while the owner can still undo a delete. nextFireAt is the time it had, absent if it was paused.
    deleting: v.optional(v.object({ until: v.number(), nextFireAt: v.optional(v.number()) })),
  })
    .index("by_bot", ["botId"])
    .index("by_owner", ["ownerId"])
    .index("by_owner_next_fire", ["ownerId", "nextFireAt"])
    .index("by_next_fire", ["nextFireAt"]),

  runs: defineTable({
    threadId: v.id("threads"),
    botId: v.id("bots"),
    ownerId: v.id("users"),
    trigger: runTrigger,
    capability: runCapability,
    scheduleId: v.optional(v.id("schedules")),
    deadlineAt: v.optional(v.number()),
    endedAt: v.optional(v.number()),
    // A routine run that ended with stay_quiet, so its earlier reports and the runs kept for them skip it.
    quiet: v.optional(v.literal(true)),
    state: runState,
    cancelRequested: v.boolean(),
    nextSeq: v.number(),
    lastClaimSeq: v.optional(v.number()),
    claimsWithoutProgress: v.optional(v.number()),
    computerGeneration: v.optional(v.number()),
  })
    .index("by_thread", ["threadId"])
    .index("by_state", ["state.kind"])
    .index("by_schedule", ["scheduleId"])
    .index("by_owner", ["ownerId"])
    .index("by_owner_state", ["ownerId", "state.kind"])
    .index("by_owner_trigger", ["ownerId", "trigger"])
    .index("by_bot_state", ["botId", "state.kind"])
    .index("by_bot_ended", ["botId", "endedAt"]),

  runEvents: defineTable({
    runId: v.id("runs"),
    threadId: v.id("threads"),
    seq: v.number(),
    body: runEventBody,
  })
    .index("by_run_seq", ["runId", "seq"])
    .index("by_thread", ["threadId"])
    .index("by_run_kind_seq", ["runId", "body.kind", "seq"])
    .index("by_run_call_seq", ["runId", "body.toolCallId", "seq"])
    .index("by_run_outcome", ["runId", "body.outcome"]),

  runStreams: defineTable({
    runId: v.id("runs"),
    text: v.string(),
    reasoning: v.optional(v.string()),
  }).index("by_run", ["runId"]),

  // The newest look of a run. A run has at most one, and endRun deletes it, so no picture of the owner's pages outlives its run.
  screens: defineTable({
    runId: v.id("runs"),
    ownerId: v.id("users"),
    toolCallId: v.string(),
    view: v.string(),
    image: v.optional(screenImageBytes),
  }).index("by_run", ["runId"]),
});
