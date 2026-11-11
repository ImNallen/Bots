import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { api } from "@bots/convex";
import { ConvexHttpClient } from "convex/browser";
import { SignJWT, importJWK } from "jose";
import { paths, parsePrivateJwk, readEnvFile, runConvex } from "./lib.ts";

const env = readEnvFile(paths.rootEnv);
assert(env.CONVEX_URL?.startsWith("http://127.0.0.1:"), "Only a local backend is allowed");
assert(env.JWT_PRIVATE_JWK && env.JWT_ISSUER);
const jwk = parsePrivateJwk(env.JWT_PRIVATE_JWK);
const key = await importJWK(jwk, "ES256");
async function client(subject: string) {
  const client = new ConvexHttpClient(env.CONVEX_URL!);
  client.setAuth(await new SignJWT({ email: "reset-check@localhost", name: "Reset check" }).setProtectedHeader({ alg: "ES256", kid: jwk.kid }).setSubject(subject).setIssuer(env.JWT_ISSUER!).setAudience("bots").setIssuedAt().setExpirationTime("1h").sign(key));
  return client;
}
const subject = `dev:reset-check-${randomUUID()}@localhost`;
const owner = await client(subject);
const other = await client(`dev:reset-other-${randomUUID()}@localhost`);
const service = await client("service:orchestrator");
await owner.mutation(api.users.ensureCurrent, {});
await other.mutation(api.users.ensureCurrent, {});
await assert.rejects(other.mutation(api.computers.reset, {}));
await assert.rejects(service.mutation(api.computers.reset, {}));
const declared = await service.mutation(api.computers.declareVm, { ownerSubject: subject, email: "reset-check@localhost", displayName: "Reset check", cores: 2, memoryMb: 2048, diskGb: 32 });
const computerId = declared.computerId;
const captured = { computerId, generation: 0 };
const oldHash = randomUUID();
await service.mutation(api.computers.recordVmToken, { ...captured, tokenHash: oldHash });
const botId = await owner.mutation(api.bots.create, { name: "Reset check", color: "green", shape: "ball" });
await owner.mutation(api.memories.write, { botId, text: "Keep this note" });
const notes = await owner.query(api.memories.list, { botId });
const threadId = await owner.mutation(api.threads.ensureForBot, { botId });
const runId = await owner.mutation(api.threads.send, { threadId, text: "Preserve this chat" });
const queuedBot = await owner.mutation(api.bots.create, { name: "Queued reset check", color: "green", shape: "ball" });
const queuedThread = await owner.mutation(api.threads.ensureForBot, { botId: queuedBot });
const queuedRun = await owner.mutation(api.threads.send, { threadId: queuedThread, text: "Queued work" });
const otherBot = await other.mutation(api.bots.create, { name: "Other owner", color: "green", shape: "ball" });
const otherThread = await other.mutation(api.threads.ensureForBot, { botId: otherBot });
const otherRun = await other.mutation(api.threads.send, { threadId: otherThread, text: "Keep working" });
const claim = await service.mutation(api.runs.claim, { runId });
assert.equal(claim.kind, "claimed");
assert(claim.kind === "claimed");
await service.mutation(api.runs.append, { runId, leaseToken: claim.leaseToken, expectedSeq: 1, body: { kind: "assistantTurn", text: "Earlier turn", toolCalls: [{ id: "reused", name: "shell", arguments: "{}" }], model: "test", usage: { promptTokens: 0, completionTokens: 0 } } });
await service.mutation(api.runs.append, { runId, leaseToken: claim.leaseToken, expectedSeq: 2, body: { kind: "toolResult", toolCallId: "reused", name: "shell", outcome: "ok", output: "earlier result", truncated: false } });
await service.mutation(api.runs.append, { runId, leaseToken: claim.leaseToken, expectedSeq: 3, body: { kind: "assistantTurn", text: "Starting calls", toolCalls: ["reused", "answered", "unanswered", "also-unanswered"].map((id) => ({ id, name: "shell", arguments: "{}" })), model: "test", usage: { promptTokens: 0, completionTokens: 0 } } });
await service.mutation(api.runs.append, { runId, leaseToken: claim.leaseToken, expectedSeq: 4, body: { kind: "toolResult", toolCallId: "answered", name: "shell", outcome: "ok", output: "done", truncated: false } });
await owner.mutation(api.runs.requestCancel, { runId });
const approval = await service.mutation(api.approvals.request, { runId, toolCallId: "pending", toolName: "shell" });
await owner.mutation(api.bots.takeOver, { botId });
const routine = runConvex(["run", "scheduleChecks:createForCheck", JSON.stringify({ botId, instruction: "Keep the routine" })]);
assert.equal(routine.kind, "ok");
assert(routine.kind === "ok");
const schedule: { scheduleId: string } = JSON.parse(routine.stdout);
const seeded = runConvex(["run", "resetChecks:seed", JSON.stringify({ computerId, botId, count: 70 })]);
assert(seeded.kind === "ok");
const batchRoutines: string[] = JSON.parse(seeded.stdout);
await owner.mutation(api.computers.reset, {});
await service.mutation(api.computers.completeReset, { computerId, generation: 1 });
assert.equal((await owner.query(api.computers.current, {})).kind, "resetting");
const pendingReset = await owner.query(api.computers.current, {});
await owner.mutation(api.computers.reset, {});
assert.deepEqual(await owner.query(api.computers.current, {}), pendingReset);
await assert.rejects(service.mutation(api.computers.declareVm, { ownerSubject: subject, email: "reset-check@localhost", displayName: "Reset check", cores: 4, memoryMb: 4096, diskGb: 64 }));
await assert.rejects(service.mutation(api.computers.register, { ownerSubject: subject, email: "reset-check@localhost", displayName: "Reset check", tokenHash: "replacement" }));
assert.equal((await owner.query(api.computers.current, {})).kind, "resetting");
assert.equal(await service.query(api.computers.byTokenHash, { tokenHash: oldHash }), null);
assert.equal((await service.mutation(api.runs.heartbeat, { runId, leaseToken: claim.leaseToken })).kind, "lost");
assert.equal((await service.mutation(api.runs.claim, { runId })).kind, "unavailable");
assert.equal((await service.mutation(api.runs.claim, { runId: queuedRun })).kind, "unavailable");
assert.equal((await service.mutation(api.runs.claim, { runId: otherRun })).kind, "claimed");
await other.mutation(api.runs.requestCancel, { runId: otherRun });
assert.equal(await service.query(api.approvals.stateOf, { approvalId: approval.approvalId }), "expired");
await assert.rejects(owner.mutation(api.threads.send, { threadId, text: "Blocked" }));
await assert.rejects(owner.mutation(api.bots.takeOver, { botId }));
await assert.rejects(service.mutation(api.approvals.request, { runId, toolCallId: "late", toolName: "shell" }));
await assert.rejects(service.mutation(api.runs.append, { runId, leaseToken: claim.leaseToken, expectedSeq: 5, body: { kind: "assistantTurn", text: "Late", toolCalls: [], model: "test", usage: { promptTokens: 0, completionTokens: 0 } } }));
await assert.rejects(service.mutation(api.runs.patchStream, { runId, leaseToken: claim.leaseToken, text: "Late stream" }));
await assert.rejects(service.mutation(api.runs.finish, { runId, leaseToken: claim.leaseToken, state: { kind: "done" } }));
await assert.rejects(owner.mutation(api.approvals.decide, { approvalId: approval.approvalId, decision: "approved" }));
for (const operation of [
  () => service.mutation(api.computers.recordVmToken, { ...captured, tokenHash: "stale" }),
  () => service.mutation(api.computers.recordObservedVm, { ...captured, stage: "ready" }),
  () => service.mutation(api.computers.recordComputerdCommit, { ...captured, commit: "stale" }),
  () => service.mutation(api.computers.fenceForUpdate, captured),
  () => service.mutation(api.computers.releaseUpdateFence, captured),
  () => service.mutation(api.computers.forgetVm, captured),
  () => service.mutation(api.computers.completeReset, captured),
]) await assert.rejects(operation());
let cleanupFinished = false;
for (let attempt = 0; attempt < 120; attempt++) {
  const inspected = runConvex(["run", "resetChecks:inspect", JSON.stringify({ computerId })]);
  assert(inspected.kind === "ok");
  const state = JSON.parse(inspected.stdout);
  if (state.cleanup === undefined) {
    assert.equal(state.active, 0);
    assert.equal(state.cancelled, 1);
    assert.equal(state.pending, 0);
    assert.equal(state.takeovers, 0);
    cleanupFinished = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
assert(cleanupFinished, "Durable cleanup finishes across multiple batches");
const computers = await service.query(api.computers.desiredVms, {});
const reset = computers.find((row) => row.computerId === computerId);
assert(reset);
assert.equal(reset.desiredVm.slot, declared.slot);
assert.equal(reset.desiredVm.generation, 1);
assert.equal(reset.desiredVm.memoryMb, 2048);
assert.equal(reset.hasActiveRun, false);
assert(await owner.query(api.bots.get, { botId }));
assert.deepEqual(await owner.query(api.memories.list, { botId }), notes);
const events = await service.query(api.runs.eventsPage, { runId, paginationOpts: { cursor: null, numItems: 20 } });
for (const id of ["answered", "unanswered", "also-unanswered"]) assert.equal(events.page.filter((event) => event.body.kind === "toolResult" && event.body.toolCallId === id).length, 1);
assert.equal(events.page.filter((event) => event.body.kind === "toolResult" && event.body.toolCallId === "reused").length, 2);
assert(events.page.some((event) => event.body.kind === "userMessage" && event.body.text === "Preserve this chat"));
const due = runConvex(["run", "scheduleChecks:moveForCheck", JSON.stringify({ scheduleId: schedule.scheduleId, nextFireAt: Date.now() - 1000 })]);
assert.equal(due.kind, "ok");
const tick = runConvex(["run", "schedules:fireDue", "{}"]);
assert.equal(tick.kind, "ok");
const routines = await owner.query(api.schedules.listForBot, { botId });
assert(routines?.routines.length === 71);
assert(routines.routines.some((routine) => routine.kind === "live" && (routine.nextFireAt ?? 0) > Date.now()));
const fire = runConvex(["run", "scheduleChecks:fireForCheck", JSON.stringify({ scheduleId: schedule.scheduleId })]);
assert.equal(fire.kind, "failed");
await service.mutation(api.computers.recordVmToken, { computerId, generation: 1, tokenHash: randomUUID() });
await service.mutation(api.computers.recordObservedVm, { computerId, generation: 1, stage: "connecting" });
assert.equal((await owner.query(api.computers.current, {})).kind, "resetting");
const movedBatch = runConvex(["run", "resetChecks:makeDue", JSON.stringify({ scheduleIds: batchRoutines })]);
assert.equal(movedBatch.kind, "ok");
await service.mutation(api.computers.completeReset, { computerId, generation: 1 });
assert.equal((await owner.query(api.computers.current, {})).kind, "resetting", "Completion waits for all due routine batches");
for (let attempt = 0; attempt < 10 && (await owner.query(api.computers.current, {})).kind === "resetting"; attempt++) {
  await service.mutation(api.computers.completeReset, { computerId, generation: 1 });
}
assert.equal((await owner.query(api.computers.current, {})).kind, "available");
await service.mutation(api.computers.completeReset, { computerId, generation: 1 });
const completedRoutines = await owner.query(api.schedules.listForBot, { botId });
assert(completedRoutines?.routines.every((routine) => routine.kind === "live" && (routine.nextFireAt ?? 0) > Date.now()));
console.log("verify:reset passed against a real local Convex backend. No Proxmox VM was accessed. Completion used a service call to stand in for connection evidence. Real VM connectivity remains unverified.");
