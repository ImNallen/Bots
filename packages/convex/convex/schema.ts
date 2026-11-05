import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { desiredVm, observedVm, runEventBody, runState } from "./validators.js";

export default defineSchema({
  users: defineTable({
    authSubject: v.string(),
    email: v.string(),
    displayName: v.string(),
  }).index("by_auth_subject", ["authSubject"]),

  bots: defineTable({
    ownerId: v.id("users"),
    name: v.string(),
  }).index("by_owner", ["ownerId"]),

  computers: defineTable({
    ownerId: v.id("users"),
    // A provisioned computer has no hash until its VM makes a token.
    tokenHash: v.optional(v.string()),
    // Only provisioned computers have these. A dev computer is a local container.
    desiredVm: v.optional(desiredVm),
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
  }).index("by_owner", ["ownerId"]),

  threads: defineTable({
    botId: v.id("bots"),
    ownerId: v.id("users"),
  }).index("by_bot", ["botId"]),

  runs: defineTable({
    threadId: v.id("threads"),
    botId: v.id("bots"),
    ownerId: v.id("users"),
    trigger: v.literal("user"),
    capability: v.literal("full"),
    state: runState,
    cancelRequested: v.boolean(),
    nextSeq: v.number(),
    lastClaimSeq: v.optional(v.number()),
    claimsWithoutProgress: v.optional(v.number()),
  })
    .index("by_thread", ["threadId"])
    .index("by_state", ["state.kind"]),

  runEvents: defineTable({
    runId: v.id("runs"),
    threadId: v.id("threads"),
    seq: v.number(),
    body: runEventBody,
  })
    .index("by_run_seq", ["runId", "seq"])
    .index("by_thread", ["threadId"]),

  runStreams: defineTable({
    runId: v.id("runs"),
    text: v.string(),
    reasoning: v.optional(v.string()),
  }).index("by_run", ["runId"]),
});
