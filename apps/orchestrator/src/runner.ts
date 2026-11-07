import { api } from "@bots/convex";
import type { Doc, Id } from "@bots/convex/dataModel";
import { isMemoryInvocation, makeCallId, parseToolCall, toolDefinitions } from "@bots/protocol";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { ConvexError } from "convex/values";
import type { Link } from "./link.ts";
import type { LogFields } from "./log.ts";
import { DENIED_OUTPUT, EXPIRED_OUTPUT, NOT_SENT_CANCELLED_OUTPUT, needsApproval, waitForApproval } from "./approvals.ts";
import { waitWhileTakenOver } from "./takeover.ts";
import { completeWithRetry, type CompletionResult } from "./mistral.ts";
import {
  MAX_ASSISTANT_TURNS,
  nextAction,
  systemPrompt,
  toMistralMessages,
  touchedComputer,
  withUniqueToolCallIds,
  type ToolCall,
} from "./run-logic.ts";
import { decryptApiKey } from "./secrets.ts";
import type { Service } from "./service.ts";
import { createStreamWriter } from "./stream-writer.ts";

const MAX_CONCURRENT_RUNS = 8;
const LEASE_MS = 15_000;
const HEARTBEAT_MS = 5000;
const EXPIRED_POLL_MS = 5000;
const EVENTS_PAGE_ITEMS = 64;
const EVENTS_PAGE_BYTES = 4 * 1024 * 1024;

const NO_KEY_REASON = "No Mistral API key is set. Add one in the Mistral key section on the home page.";
const UNREADABLE_KEY_REASON = "The stored Mistral key could not be decrypted. Set it again on the home page.";
const STEP_LIMIT_REASON = `The run stopped after ${MAX_ASSISTANT_TURNS} model turns.`;

type Claim = Extract<FunctionReturnType<typeof api.runs.claim>, { kind: "claimed" }>;
type RunEvent = Pick<Doc<"runEvents">, "runId" | "body">;
type AppendBody = FunctionArgs<typeof api.runs.append>["body"];

type Lease = {
  lost: AbortSignal;
  cancel: AbortSignal;
  stop: () => void;
};

// A run that waits for a person does no work, so it gives up its slot. Otherwise unanswered approvals would stop every other bot.
type Slot = { release: () => void; reclaim: () => void };

export type RunnerDeps = {
  slotFor: (runId: Id<"runs">) => Slot;
  service: Service;
  link: Link;
  masterKey: Buffer;
  mistral: { baseUrl: string; model: string };
  ownerScope: Id<"users"> | undefined;
  log: (fields: LogFields) => void;
};

// A failed renewal is not a lost lease until the lease could have expired, and past that point another runner may hold it.
function holdLease(args: { deps: RunnerDeps; runId: Id<"runs">; claim: Claim }): Lease {
  const { deps, runId, claim } = args;
  const lost = new AbortController();
  const cancel = new AbortController();
  if (claim.cancelRequested) {
    cancel.abort();
  }
  let renewedAt = Date.now();
  let renewing = false;

  async function renew(): Promise<void> {
    const startedAt = Date.now();
    const beat = await deps.service.mutation(api.runs.heartbeat, { runId, leaseToken: claim.leaseToken });
    if (beat.kind === "lost") {
      lost.abort(new Error("lease lost"));
      return;
    }
    renewedAt = startedAt;
    if (beat.cancelRequested) {
      cancel.abort();
    }
  }

  const interval = setInterval(() => {
    if (Date.now() - renewedAt >= LEASE_MS) {
      lost.abort(new Error("lease expired without a renewal"));
    }
    if (renewing || lost.signal.aborted) {
      return;
    }
    renewing = true;
    renew()
      .catch((error: unknown) => {
        deps.log({
          level: "warn",
          event: "heartbeat-failed",
          runId,
          message: error instanceof Error ? error.message : "unknown error",
        });
      })
      .finally(() => {
        renewing = false;
      });
  }, HEARTBEAT_MS);

  return { lost: lost.signal, cancel: cancel.signal, stop: () => clearInterval(interval) };
}

async function loadThreadEvents(service: Service, threadId: Id<"threads">): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page: FunctionReturnType<typeof api.threads.eventsPage> = await service.query(api.threads.eventsPage, {
      threadId,
      paginationOpts: { numItems: EVENTS_PAGE_ITEMS, cursor, maximumBytesRead: EVENTS_PAGE_BYTES },
    });
    events.push(...page.page);
    if (page.isDone) {
      return events;
    }
    cursor = page.continueCursor;
  }
}

async function callModel(args: {
  deps: RunnerDeps;
  runId: Id<"runs">;
  claim: Claim;
  lease: Lease;
  events: readonly RunEvent[];
}): Promise<CompletionResult> {
  const { deps, runId, claim, lease, events } = args;
  const credential = await deps.service.query(api.credentials.ciphertextFor, { ownerId: claim.ownerId });
  if (credential === null) {
    return { kind: "failed", reason: NO_KEY_REASON };
  }
  let apiKey: string;
  try {
    apiKey = decryptApiKey({ masterKey: deps.masterKey, ownerId: claim.ownerId, encrypted: credential });
  } catch {
    return { kind: "failed", reason: UNREADABLE_KEY_REASON };
  }
  const profile = await deps.service.query(api.bots.promptFor, { botId: claim.botId });
  const writer = createStreamWriter({
    // The stream is a preview. Fencing rejects a stale write, and the turn itself goes through append.
    write: async (snapshot) => {
      try {
        await deps.service.mutation(api.runs.patchStream, { runId, leaseToken: claim.leaseToken, ...snapshot });
      } catch (error) {
        deps.log({
          level: "warn",
          event: "stream-write-failed",
          runId,
          message: error instanceof Error ? error.message : "unknown error",
        });
      }
    },
  });
  const result = await completeWithRetry({
    ...deps.mistral,
    apiKey,
    messages: toMistralMessages({
      system: systemPrompt({
        botName: profile.name,
        botId: claim.botId,
        title: profile.title,
        assignment: profile.assignment,
        about: profile.about,
        notes: profile.notes,
      }),
      events: events.map((event) => event.body),
    }),
    tools: toolDefinitions,
    signal: AbortSignal.any([lease.lost, lease.cancel]),
    onAttempt: () => writer.update({ text: "" }),
    onProgress: (snapshot) => writer.update(snapshot),
    log: deps.log,
  });
  await writer.flush();
  return result;
}

async function runTool(args: {
  deps: RunnerDeps;
  runId: Id<"runs">;
  claim: Claim;
  lease: Lease;
  call: ToolCall;
  touched: boolean;
}): Promise<AppendBody> {
  const { deps, runId, claim, lease, call, touched } = args;
  const slot = deps.slotFor(runId);
  const base = { kind: "toolResult" as const, toolCallId: call.id, name: call.name };
  const parsed = parseToolCall(call);
  if (parsed.kind === "invalid") {
    deps.log({ level: "info", event: "tool-invalid", runId, toolCallId: call.id });
    return { ...base, outcome: "invalid", output: parsed.reason, truncated: false };
  }
  const level = await deps.service.query(api.bots.approvalLevelFor, { botId: claim.botId });
  const { invocation } = parsed;
  if (needsApproval({ level, toolName: invocation.name, touchedComputer: touched })) {
    const decision = await waitForApproval({
      request: () =>
        deps.service.mutation(api.approvals.request, { runId, toolCallId: call.id, toolName: invocation.name }),
      read: (approvalId) => deps.service.query(api.approvals.stateOf, { approvalId }),
      expire: (approvalId) => deps.service.mutation(api.approvals.expire, { approvalId }),
      now: Date.now,
      signals: [lease.lost, lease.cancel],
      onWait: () => {
        deps.log({ level: "info", event: "tool-waiting-for-approval", runId, toolCallId: call.id });
        slot.release();
      },
    }).finally(() => slot.reclaim());
    lease.lost.throwIfAborted();
    deps.log({ level: "info", event: "tool-approval", runId, toolCallId: call.id, decision });
    // This call was never sent, so these results can say so with certainty.
    switch (decision) {
      case "approved":
        break;
      case "aborted":
        return { ...base, outcome: "cancelled", output: NOT_SENT_CANCELLED_OUTPUT, truncated: false };
      case "denied":
        return { ...base, outcome: "denied", output: DENIED_OUTPUT, truncated: false };
      case "expired":
        return { ...base, outcome: "denied", output: EXPIRED_OUTPUT, truncated: false };
    }
  }
  if (isMemoryInvocation(invocation)) {
    return invocation.name === "memory_save"
      ? { kind: "memorySave", toolCallId: call.id, text: invocation.args.text }
      : { kind: "memoryForget", toolCallId: call.id, noteId: invocation.args.id };
  }
  await waitWhileTakenOver({
    until: () => deps.service.query(api.bots.takeoverUntil, { botId: claim.botId }),
    now: Date.now,
    signals: [lease.lost, lease.cancel],
    onWait: () => {
      deps.log({ level: "info", event: "tool-waiting-for-takeover", runId, toolCallId: call.id });
      slot.release();
    },
  }).finally(() => slot.reclaim());
  lease.lost.throwIfAborted();
  const callId = makeCallId({ runId, toolCallId: call.id });
  deps.log({ level: "info", event: "tool-dispatch", callId, tool: invocation.name });
  const result = await deps.link.call({
    ownerId: claim.ownerId,
    callId,
    botId: claim.botId,
    tool: invocation,
    lost: lease.lost,
    cancel: lease.cancel,
  });
  deps.log({ level: "info", event: "tool-result", callId, outcome: result.outcome, truncated: result.truncated });
  return { ...base, ...result };
}

// The only state that survives one pass of this loop is what Convex stored, which is why a restart resumes it.
async function driveRun(args: { deps: RunnerDeps; runId: Id<"runs">; claim: Claim; lease: Lease }): Promise<void> {
  const { deps, runId, claim, lease } = args;
  const { service, log } = deps;
  const { leaseToken } = claim;
  const events = await loadThreadEvents(service, claim.threadId);
  let nextSeq = claim.nextSeq;

  async function append(body: AppendBody): Promise<void> {
    const stored = await service.mutation(api.runs.append, { runId, leaseToken, expectedSeq: nextSeq, body });
    nextSeq += 1;
    events.push({ runId, body: stored });
  }

  async function finish(state: FunctionArgs<typeof api.runs.finish>["state"]): Promise<void> {
    await service.mutation(api.runs.finish, { runId, leaseToken, state });
    log({ level: "info", event: "run-finished", runId, state: state.kind });
  }

  for (;;) {
    lease.lost.throwIfAborted();
    const runEvents = events.filter((event) => event.runId === runId).map((event) => event.body);
    const action = nextAction(runEvents);
    if (lease.cancel.aborted && action.kind !== "runTool") {
      await finish({ kind: "cancelled" });
      return;
    }
    switch (action.kind) {
      case "finish":
        await finish({ kind: "done" });
        return;
      case "fail":
        await finish({ kind: "failed", reason: STEP_LIMIT_REASON });
        return;
      case "runTool":
        await append(await runTool({ deps, runId, claim, lease, call: action.call, touched: touchedComputer(runEvents) }));
        break;
      case "callModel": {
        let result: CompletionResult;
        try {
          result = await callModel({ deps, runId, claim, lease, events });
        } catch (error) {
          if (lease.lost.aborted || !lease.cancel.aborted) {
            throw error;
          }
          continue;
        }
        if (result.kind === "failed") {
          await finish({ kind: "failed", reason: result.reason });
          return;
        }
        const toolCalls = withUniqueToolCallIds({ calls: result.turn.toolCalls, events: runEvents });
        await append({ kind: "assistantTurn", ...result.turn, toolCalls });
        break;
      }
    }
  }
}

export function startRunner(args: Omit<RunnerDeps, "slotFor">): void {
  const { service, log, ownerScope } = args;
  const active = new Set<Id<"runs">>();
  const waiting = new Set<Id<"runs">>();
  // Asking again at once would spin for as long as the refusal lasts, up to a minute under an update fence. So a run stays here
  // from its claim until the claim is won, or until the next poll or list change.
  const refused = new Set<Id<"runs">>();
  let queued: Id<"runs">[] = [];
  const deps: RunnerDeps = {
    ...args,
    slotFor: (runId) => ({
      release: () => {
        waiting.add(runId);
        queued.forEach(consider);
      },
      reclaim: () => {
        waiting.delete(runId);
      },
    }),
  };

  async function attempt(runId: Id<"runs">): Promise<void> {
    refused.add(runId);
    const claim = await service.mutation(api.runs.claim, { runId });
    if (claim.kind === "unavailable") {
      return;
    }
    refused.delete(runId);
    log({ level: "info", event: "run-claimed", runId, seq: claim.nextSeq });
    const lease = holdLease({ deps, runId, claim });
    try {
      await driveRun({ deps, runId, claim, lease });
    } finally {
      lease.stop();
    }
  }

  // Any failure ends the attempt and leaves the lease to expire, so recovery takes the same path as a crash.
  function consider(runId: Id<"runs">): void {
    if (active.has(runId) || refused.has(runId) || active.size - waiting.size >= MAX_CONCURRENT_RUNS) {
      return;
    }
    active.add(runId);
    attempt(runId)
      .catch((error: unknown) => {
        const fenced = error instanceof ConvexError && error.data === "Lease lost";
        log({
          level: "warn",
          event: fenced ? "run-lease-lost" : "run-attempt-ended",
          runId,
          message: error instanceof Error ? error.message : "unknown error",
        });
      })
      .finally(() => {
        active.delete(runId);
        waiting.delete(runId);
        queued.forEach(consider);
      });
  }

  service.subscribe(api.runs.listQueued, { ownerId: ownerScope }, (ids) => {
    queued = ids;
    refused.clear();
    queued.forEach(consider);
  });

  setInterval(() => {
    service
      .query(api.runs.listClaimable, { now: Date.now(), ownerId: ownerScope })
      .then((ids) => {
        refused.clear();
        ids.forEach(consider);
      })
      .catch((error: unknown) => {
        log({
          level: "warn",
          event: "claim-poll-failed",
          message: error instanceof Error ? error.message : "unknown error",
        });
      });
  }, EXPIRED_POLL_MS);
}
