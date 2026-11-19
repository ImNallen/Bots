import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createTcpServer, type Socket } from "node:net";
import { once } from "node:events";
import { join } from "node:path";
import { api } from "@bots/convex";
import type { Id } from "@bots/convex/dataModel";
import { TAKEOVER_COMPLETED_OUTPUT } from "@bots/protocol";
import { ConvexHttpClient } from "convex/browser";
import { importJWK, SignJWT } from "jose";
import { chromium } from "playwright";
import { WebSocket } from "ws";
import { connectLink } from "../apps/computerd/src/link.ts";
import { createCalls } from "../apps/computerd/src/calls.ts";
import { openJournal } from "../apps/computerd/src/journal.ts";
import { createControlActivation, relayScreen } from "../apps/computerd/src/screens.ts";
import { desktopOf, streamPort } from "../apps/computerd/src/desktops.ts";
import { encryptApiKey } from "../apps/orchestrator/src/secrets.ts";
import { paths, parsePrivateJwk, readEnvFile } from "./lib.ts";

const env = readEnvFile(paths.rootEnv);
const url = env.CONVEX_URL;
assert(url && url.startsWith("http://127.0.0.1:"));
assert.notEqual(new URL(url).port, "3210", "Use a disposable backend");
assert.equal(readEnvFile(paths.convexEnv).CONVEX_SELF_HOSTED_URL, url);
assert(env.JWT_PRIVATE_JWK && env.JWT_ISSUER && env.MASTER_KEY && env.PORT && env.LINK_PORT);
const output = process.env.VERIFY_OUTPUT_DIR ?? "/tmp/bots-handoff-proof";
await mkdir(output, { recursive: true });
const jwk = parsePrivateJwk(env.JWT_PRIVATE_JWK), key = await importJWK(jwk, "ES256");
const email = `handoff-${randomUUID()}@example.test`, subject = `dev:${email}`;
async function client(subject: string) {
  const c = new ConvexHttpClient(url!);
  c.setAuth(await new SignJWT({ email, name: "Handoff proof" }).setProtectedHeader({ alg: "ES256", kid: jwk.kid }).setSubject(subject).setIssuer(env.JWT_ISSUER!).setAudience("bots").setIssuedAt().setExpirationTime("2h").sign(key));
  return c;
}
const owner = await client(subject), service = await client("service:orchestrator"), other = await client(`dev:other-${email}`);
const user = await owner.mutation(api.users.ensureCurrent, {});
await other.mutation(api.users.ensureCurrent, {});
const token = randomBytes(32).toString("base64url");
await service.mutation(api.computers.register, { ownerSubject: subject, email, displayName: "Handoff proof", tokenHash: createHash("sha256").update(token).digest("hex") });
await service.mutation(api.credentials.store, { ownerId: user._id, ...encryptApiKey({ ownerId: user._id, masterKey: Buffer.from(env.MASTER_KEY, "base64"), apiKey: "scripted-only" }) });
function check(fn: string, args: object) { return execFileSync(paths.convexBin, ["run", fn, JSON.stringify(args)], { cwd: paths.convexDir, encoding: "utf8", stdio: "pipe" }); }
const alter = (runId: Id<"runs">, mode: string) => check("handoffFixtures:alter", { runId, mode });
const expire = (runId: Id<"runs">) => check("pageChecks:expireLease", { runId });
async function until<T>(probe: () => Promise<T | null>, label: string): Promise<T> {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { const v = await probe(); if (v !== null) return v; await new Promise(r => setTimeout(r, 30)); }
  throw Error(`Timed out waiting for ${label}`);
}
async function fixture(options: { sibling?: boolean; prior?: boolean; reason?: string } = {}, caller = owner) {
  const botId = await caller.mutation(api.bots.create, { name: "Handoff proof", color: "green" });
  const threadId = await caller.mutation(api.threads.ensureForBot, { botId });
  const runId = await caller.mutation(api.threads.send, { threadId, text: "help privately" });
  const claim = await service.mutation(api.runs.claim, { runId });
  assert.equal(claim.kind, "claimed"); if (claim.kind !== "claimed") throw Error("claim");
  const call = { id: randomUUID(), name: "request_takeover", arguments: JSON.stringify({ reason: options.reason ?? "  Please sign in on the screen  " }) };
  const sibling = { id: randomUUID(), name: "browser_click", arguments: '{"ref":1}' };
  const prior = { id: randomUUID(), name: "read_file", arguments: '{"path":"/workspace/note"}' };
  const calls = [...(options.prior ? [prior] : []), call, ...(options.sibling ? [sibling] : [])];
  await service.mutation(api.runs.append, { runId, leaseToken: claim.leaseToken, expectedSeq: claim.nextSeq, body: { kind: "assistantTurn", text: "", toolCalls: calls, model: "fixture", usage: { promptTokens: 1, completionTokens: 1 } } });
  const identity = { runId, toolCallId: call.id };
  const request = () => service.mutation(api.handoffs.request, { ...identity, leaseToken: claim.leaseToken });
  const state = () => service.query(api.handoffs.stateOf, identity);
  const decide = (decision: { kind: "complete"; controlSessionId?: string } | { kind: "decline" }) => caller.mutation(api.handoffs.decide, { ...identity, decision });
  const timeline = () => caller.query(api.threads.timeline, { threadId });
  const result = { kind: "toolResult" as const, name: call.name, toolCallId: call.id, outcome: "ok" as const, output: "forged success", truncated: false };
  const append = () => service.mutation(api.runs.append, { runId, leaseToken: claim.leaseToken, expectedSeq: claim.nextSeq + 1, body: result });
  const cancel = () => caller.mutation(api.runs.requestCancel, { runId });
  return { botId, threadId, runId, claim, call, sibling, identity, request, state, decide, timeline, append, cancel };
}

let f = await fixture({ sibling: true });
await assert.rejects(owner.mutation(api.handoffs.request, { ...f.identity, leaseToken: f.claim.leaseToken }));
await assert.rejects(other.mutation(api.handoffs.decide, { ...f.identity, decision: { kind: "complete" } }));
await assert.rejects(service.mutation(api.handoffs.request, { ...f.identity, leaseToken: "wrong" }));
assert.equal((await f.request()).kind, "pending");
const original = await f.state(); assert.equal(original.kind, "pending"); if (original.kind === "pending") assert.equal(original.reason, "Please sign in on the screen");
await assert.rejects(f.append());
await assert.rejects(service.mutation(api.runs.append, { runId: f.runId, leaseToken: f.claim.leaseToken, expectedSeq: f.claim.nextSeq + 1, body: { kind: "assistantTurn", text: "skip help", toolCalls: [], model: "forged", usage: { promptTokens: 0, completionTokens: 0 } } }));
await assert.rejects(service.mutation(api.runs.finish, { runId: f.runId, leaseToken: f.claim.leaseToken, state: { kind: "done" } }));
const a = await owner.mutation(api.bots.takeOver, { botId: f.botId, action: { kind: "acquire" } });
const b = await owner.mutation(api.bots.takeOver, { botId: f.botId, action: { kind: "acquire" } });
assert.notEqual(a.sessionId, b.sessionId);
await assert.rejects(owner.mutation(api.bots.takeOver, { botId: f.botId, action: { kind: "renew", sessionId: a.sessionId } }));
await owner.mutation(api.bots.releaseTakeover, { botId: f.botId, sessionId: a.sessionId });
assert.equal((await owner.query(api.bots.get, { botId: f.botId }))?.takeoverSessionId, b.sessionId);
await assert.rejects(f.decide({ kind: "complete" }));
await assert.rejects(f.decide({ kind: "complete", controlSessionId: a.sessionId }));
alter(f.runId, "views");
assert.equal((await f.decide({ kind: "complete", controlSessionId: b.sessionId })).kind, "completed");
const next = await owner.mutation(api.bots.takeOver, { botId: f.botId, action: { kind: "acquire" } });
assert.equal((await f.decide({ kind: "decline" })).kind, "completed");
assert.equal((await owner.query(api.bots.get, { botId: f.botId }))?.takeoverSessionId, next.sessionId);
const inspect: unknown = JSON.parse(check("pageChecks:inspect", { runId: f.runId }));
assert(typeof inspect === "object" && inspect !== null && "pages" in inspect && Array.isArray(inspect.pages)); assert.equal(inspect.pages.length, 0);
assert.equal(await service.query(api.screens.ofRun, { runId: f.runId }), null);
const saved = await f.append(); assert(saved.kind === "toolResult"); assert.equal(saved.output, TAKEOVER_COMPLETED_OUTPUT);
await assert.rejects(f.append());
assert.equal((await f.decide({ kind: "complete" })).kind, "completed");
assert.equal((await owner.query(api.bots.get, { botId: f.botId }))?.takeoverSessionId, next.sessionId);
await owner.mutation(api.bots.releaseTakeover, { botId: f.botId, sessionId: next.sessionId }); await f.cancel();
console.log("ok issue 82: stale renew/release/complete fenced; fixed atomic result, first decision, duplicate acknowledgment preserve newer control; forged success/turn/finish rejected");

for (const readOnly of [false, true]) {
  f = await fixture({ reason: "" });
  if (readOnly) alter(f.runId, "readOnly");
  const invalid = await service.mutation(api.runs.append, { runId: f.runId, leaseToken: f.claim.leaseToken, expectedSeq: f.claim.nextSeq + 1,
    body: { kind: "toolResult", name: "request_takeover", toolCallId: f.call.id, outcome: "invalid", output: "untrusted validation text", truncated: false } });
  assert(invalid.kind === "toolResult"); assert.equal(invalid.outcome, "invalid"); assert.notEqual(invalid.output, "untrusted validation text");
  await service.mutation(api.runs.append, { runId: f.runId, leaseToken: f.claim.leaseToken, expectedSeq: f.claim.nextSeq + 2,
    body: { kind: "assistantTurn", text: "Corrected the invalid call", toolCalls: [], model: "fixture", usage: { promptTokens: 0, completionTokens: 0 } } });
  await service.mutation(api.runs.finish, { runId: f.runId, leaseToken: f.claim.leaseToken, state: { kind: "done" } });
}
f = await fixture(); await f.request(); await f.decide({ kind: "complete" });
const newerControl = await owner.mutation(api.bots.takeOver, { botId: f.botId, action: { kind: "acquire" } });
await f.cancel();
assert.equal((await owner.query(api.bots.get, { botId: f.botId }))?.takeoverSessionId, newerControl.sessionId);
await owner.mutation(api.bots.releaseTakeover, { botId: f.botId, sessionId: newerControl.sessionId });
console.log("ok malformed help calls record validation failure; cancelling completed help preserves newer manual control");

f = await fixture(); await f.request(); const expired = await owner.mutation(api.bots.takeOver, { botId: f.botId, action: { kind: "acquire" } });
alter(f.runId, "expireInput");
await assert.rejects(f.decide({ kind: "complete", controlSessionId: expired.sessionId }));
assert.equal((await f.state()).kind, "pending"); assert.equal((await f.decide({ kind: "complete" })).kind, "completed"); await f.append(); await f.cancel();
f = await fixture(); await f.cancel(); assert.equal((await f.timeline()).runs[0]?.state.kind, "cancelled");
f = await fixture({ prior: true }); await assert.rejects(f.request()); await f.cancel();
f = await fixture(); expire(f.runId); await assert.rejects(f.request()); await f.cancel();
f = await fixture(); alter(f.runId, "readOnly"); await assert.rejects(f.request()); await assert.rejects(f.append()); await f.cancel();
for (const mode of ["generation", "removeBot", "reset"]) {
  f = await fixture({ sibling: true }); await f.request(); alter(f.runId, mode);
  assert.equal((await f.decide({ kind: "complete" })).kind, "invalidated");
  await assert.rejects(f.append()); assert.equal((await f.state()).kind, "invalidated");
  if (mode === "reset") alter(f.runId, "clearReset");
  await f.cancel();
}
f = await fixture({ sibling: true }); await f.request(); assert.equal((await f.decide({ kind: "decline" })).kind, "declined");
let timeline = await f.timeline(); assert.equal(timeline.runs[0]?.state.kind, "cancelled");
const closed = timeline.runs[0]?.events.map(e => e.body).filter(e => e.kind === "toolResult") ?? [];
assert.equal(closed.length, 2); assert.equal(closed[0]?.outcome, "denied"); assert.match(closed[1]?.output ?? "", /did not run/);
assert.equal((await f.request().catch(() => ({ kind: "invalidated" }))).kind, "invalidated");
f = await fixture({ sibling: true }); await f.request(); await f.cancel(); assert.equal((await f.state()).kind, "invalidated");
console.log("ok expiry never consents; explicit sessionless resume; stored first-call, lease, capability, generation, reset, deletion, cancel and transactional decline/siblings");

f = await fixture(); await f.request(); await f.decide({ kind: "complete" });
let bounded = false;
for (let attempt = 0; attempt < 7; attempt++) {
  expire(f.runId);
  const claim = await service.mutation(api.runs.claim, { runId: f.runId });
  if (claim.kind === "ended") { bounded = true; break; }
  assert.equal(claim.kind, "claimed");
}
assert(bounded, "completed requests keep the no-progress failure bound");
console.log("ok completed requests retain normal bounded recovery");
f = await fixture({}, other); await assert.rejects(f.request()); await f.cancel();
console.log("ok missing computer cannot create a help request");
if (process.env.VERIFY_HANDOFF_BACKEND_ONLY === "1") { console.log("PASS backend handoff verification"); process.exit(0); }

const models: unknown[] = [];
let modelCalls = 0;
const model = createServer(async (req, res) => {
  let raw = ""; for await (const chunk of req) raw += String(chunk);
  const body: unknown = JSON.parse(raw); models.push(body); modelCalls++;
  const hasResult = raw.includes(TAKEOVER_COMPLETED_OUTPUT);
  const noHelp = raw.includes("ordinary progress only");
  const toolCalls = hasResult || noHelp ? [] : [
    { index: 0, id: "help-call", type: "function", function: { name: "request_takeover", arguments: '{"reason":"Please sign in privately on my screen."}' } },
    { index: 1, id: "sibling-call", type: "function", function: { name: "browser_click", arguments: '{"ref":1}' } },
  ];
  const delta = toolCalls.length ? { role: "assistant", tool_calls: toolCalls } : { role: "assistant", content: "I will inspect the page again." };
  res.setHeader("Content-Type", "text/event-stream");
  res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: toolCalls.length ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`);
});
await new Promise<void>(r => model.listen(0, "127.0.0.1", r));
const addr = model.address(); assert(addr && typeof addr !== "string");
const modelPort = addr.port;
let child: ChildProcess | undefined;
const logPath = join(output, "runner.log");
async function start() {
  child = spawn(process.execPath, ["--env-file=.env.local", "apps/orchestrator/src/main.ts"], { cwd: paths.repoRoot, env: { ...process.env, DEV_LOGIN: email, COMPUTER_TOKEN: token, MISTRAL_BASE_URL: `http://127.0.0.1:${modelPort}`, COMPUTER_WAIT_MS: "500", ...Object.fromEntries(Object.entries(env).filter(([k]) => k === "PORT" || k === "LINK_PORT")) }, stdio: ["ignore", "pipe", "pipe"] });
  const log = createWriteStream(logPath, { flags: "a" }); child.stdout?.pipe(log); child.stderr?.pipe(log);
  await until(async () => { try { return (await fetch(`http://127.0.0.1:${env.PORT}/healthz`)).ok ? true : null; } catch { return null; } }, "runner health");
}
async function stop() { if (child && child.exitCode === null) { child.kill("SIGKILL"); await once(child, "exit"); } child = undefined; }
const helpRun = async () => {
  const botId = await owner.mutation(api.bots.create, { name: "Atlas", color: "green" });
  const threadId = await owner.mutation(api.threads.ensureForBot, { botId });
  const runId = await owner.mutation(api.threads.send, { threadId, text: "help privately" });
  return { botId, threadId, runId };
};
const pending = (threadId: Id<"threads">) => until(async () => {
  const run = (await owner.query(api.threads.timeline, { threadId })).runs.at(-1);
  return run?.handoff?.kind === "pending" ? run : null;
}, "pending help");
const finished = (threadId: Id<"threads">) => until(async () => {
  const run = (await owner.query(api.threads.timeline, { threadId })).runs.at(-1);
  return run?.state.kind === "done" ? run : null;
}, "original run finishes");
let ui: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let stopLink = () => {};
const tcpServers: ReturnType<typeof createTcpServer>[] = [];
const tcpClients = new Set<Socket>();
const secret = "handoff-fixture-7xy";
const keys: number[] = [];
let executions = 0;
try {
  const durable = await helpRun();
  await start(); const waiting = await pending(durable.threadId); await stop();
  const callId = waiting.handoff?.toolCallId; assert(callId);
  for (let i = 0; i < 7; i++) { expire(durable.runId); await start(); await until(async () => (await service.query(api.runs.listClaimable, { now: Date.now(), ownerId: user._id })).includes(durable.runId) ? null : true, "reclaim after restart"); await pending(durable.threadId); await stop(); }
  assert.equal((await pending(durable.threadId)).handoff?.toolCallId, callId);
  assert.equal(modelCalls, 1);
  expire(durable.runId);
  await owner.mutation(api.handoffs.decide, { runId: durable.runId, toolCallId: callId, decision: { kind: "complete" } });
  await start(); const ended = await finished(durable.threadId);
  assert.equal(ended._id, durable.runId);
  assert.equal(ended.events.filter(e => e.body.kind === "toolResult" && e.body.name === "request_takeover").length, 1);
  const siblingResult = ended.events.find(e => e.body.kind === "toolResult" && e.body.name === "browser_click");
  assert(siblingResult?.body.kind === "toolResult"); assert.equal(siblingResult.body.outcome, "invalid");
  console.log("ok original run/call survive seven runner process restarts/reclaims; completion during downtime consumed once; same-turn stale target refused");

  const blocked = await Promise.all(Array.from({ length: 10 }, () => helpRun()));
  await Promise.all(blocked.map(f => pending(f.threadId)));
  const normalBot = await owner.mutation(api.bots.create, { name: "Unrelated progress" });
  const normalThread = await owner.mutation(api.threads.ensureForBot, { botId: normalBot });
  await owner.mutation(api.threads.send, { threadId: normalThread, text: "ordinary progress only" }); await finished(normalThread);
  const beforeDecline = modelCalls;
  const declined = await pending(blocked[0]!.threadId); assert(declined.handoff);
  await owner.mutation(api.handoffs.decide, { runId: declined._id, toolCallId: declined.handoff.toolCallId, decision: { kind: "decline" } });
  await new Promise(r => setTimeout(r, 1200)); assert.equal(modelCalls, beforeDecline);
  console.log("ok ten pending requests release eight runner slots; unrelated bot advances; decline never retries model or sibling");

  const slot = 8;
  const activate = createControlActivation();
  function desktop(socket: Socket, input: boolean) {
    tcpClients.add(socket); socket.on("close", () => tcpClients.delete(socket)); socket.on("error", () => {});
    let state: "version" | "security" | "shared" | "ready" = "version";
    let buffer = Buffer.alloc(0), sent = false;
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length) {
        if (state === "version") { if (buffer.length < 12) return; buffer = buffer.subarray(12); state = "security"; socket.write(Buffer.from([1, 1])); continue; }
        if (state === "security") { buffer = buffer.subarray(1); state = "shared"; socket.write(Buffer.alloc(4)); continue; }
        if (state === "shared") { buffer = buffer.subarray(1); state = "ready";
          const name = Buffer.from("Private login fixture"), header = Buffer.alloc(24);
          header.writeUInt16BE(1280, 0); header.writeUInt16BE(800, 2); header[4] = 32; header[5] = 24; header[7] = 1;
          header.writeUInt16BE(255, 8); header.writeUInt16BE(255, 10); header.writeUInt16BE(255, 12); header[14] = 16; header[15] = 8; header.writeUInt32BE(name.length, 20);
          socket.write(Buffer.concat([header, name])); continue;
        }
        const type = buffer[0]; let length = 0;
        if (type === 0) length = 20;
        else if (type === 2) { if (buffer.length < 4) return; length = 4 + buffer.readUInt16BE(2) * 4; }
        else if (type === 3 || type === 150) length = 10;
        else if (type === 4) length = 8;
        else if (type === 5) length = 6;
        else if (type === 6) { if (buffer.length < 8) return; length = 8 + buffer.readUInt32BE(4); }
        else throw Error(`Unexpected RFB message ${type}`);
        if (buffer.length < length) return;
        if (type === 4 && input && buffer[1] === 1) keys.push(buffer.readUInt32BE(4));
        buffer = buffer.subarray(length);
        if (type === 3 && !sent) {
          const header = Buffer.alloc(16); header.writeUInt16BE(1, 2); header.writeUInt16BE(1280, 8); header.writeUInt16BE(800, 10);
          const pixels = Buffer.alloc(1280 * 800 * 4);
          for (let y = 0; y < 800; y++) for (let x = 0; x < 1280; x++) { const i = (y * 1280 + x) * 4; const shade = x > 100 && x < 1180 && y > 70 && y < 730 ? 245 : 40; pixels[i] = shade; pixels[i + 1] = shade; pixels[i + 2] = shade; }
          socket.write(Buffer.concat([header, pixels])); sent = true;
        }
      }
    }); socket.write(Buffer.from("RFB 003.008\n"));
  }
  for (const mode of ["watch", "control"] as const) {
    const tcp = createTcpServer(socket => desktop(socket, mode === "control"));
    await new Promise<void>((r, reject) => { tcp.once("error", reject); tcp.listen(streamPort(slot, mode), "127.0.0.1", r); }); tcpServers.push(tcp);
  }
  const calls = createCalls({ journal: await openJournal({ dir: join(output, "journal") }), execute: async () => { executions++; return { outcome: "ok", output: "fixture", truncated: false }; } });
  const linkUrl = `ws://127.0.0.1:${env.LINK_PORT}`;
  stopLink = connectLink({ url: linkUrl, token, calls, endBrowsing() {}, openScreen(streamId, botId, mode) {
    relayScreen({ linkUrl, token, streamId, mode, ...(mode === "control" ? { activate: activate(botId) } : {}), acquire: async () => ({ ...desktopOf(slot), release() {} }), restartInput: async () => {}, logins: { opened: async () => {}, closed: async () => {} } });
  } });
  const screenCase = blocked[1]!;
  const base = `http://127.0.0.1:${env.PORT}`;
  ui = await chromium.launch();
  const page = await ui.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(15000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${base}/bots/${screenCase.botId}`);
  await page.getByText("Needs your help", { exact: true }).last().waitFor();
  await page.getByRole("button", { name: "Open screen", exact: true }).click();
  await page.getByRole("button", { name: "Take control", exact: true }).click();
  await page.getByRole("button", { name: "Give back and resume", exact: true }).waitFor();
  await page.locator(".scr-stream canvas").click(); await page.keyboard.type(secret);
  await until(async () => keys.length >= secret.length ? true : null, "RFB input");
  assert.equal(String.fromCodePoint(...keys.filter(k => k < 128)).slice(-secret.length), secret);
  await page.getByRole("button", { name: "Minimize computer window" }).click();
  await until(async () => !(await owner.query(api.bots.get, { botId: screenCase.botId }))?.takeoverUntil ? true : null, "input release");
  assert.equal((await pending(screenCase.threadId)).handoff?.kind, "pending");
  await page.reload(); await page.getByRole("button", { name: "Resume bot", exact: true }).waitFor();
  await page.getByRole("button", { name: "Close the screen" }).click();
  await page.getByRole("button", { name: "Open screen", exact: true }).click();
  await page.getByRole("button", { name: "Take control", exact: true }).click();
  await page.getByRole("button", { name: "Give back and resume", exact: true }).waitFor();
  await page.getByRole("button", { name: "Close the screen" }).click();
  assert.equal((await pending(screenCase.threadId)).handoff?.kind, "pending");
  await page.getByRole("button", { name: "Open screen", exact: true }).click();
  await page.getByRole("button", { name: "Take control", exact: true }).click();
  await page.getByRole("button", { name: "Give back and resume", exact: true }).waitFor();
  alter(screenCase.runId, "expireInput");
  await page.getByRole("button", { name: "Take control", exact: true }).waitFor();
  assert.equal((await pending(screenCase.threadId)).handoff?.kind, "pending");
  await page.getByRole("button", { name: "Take control", exact: true }).click();
  await page.getByRole("button", { name: "Give back and resume", exact: true }).waitFor();
  for (const socket of tcpClients) socket.destroy();
  await page.getByRole("button", { name: "Take control", exact: true }).waitFor();
  assert.equal((await pending(screenCase.threadId)).handoff?.kind, "pending");
  await page.getByRole("button", { name: "Close the screen" }).click();
  const second = await ui.newPage({ viewport: { width: 1440, height: 1000 } });
  second.setDefaultTimeout(15000);
  await second.goto(`${base}/bots/${screenCase.botId}?screen=true`);
  await second.getByRole("button", { name: "Take control", exact: true }).click();
  await second.getByRole("button", { name: "Give back and resume", exact: true }).waitFor();
  await page.getByRole("button", { name: "Resume bot", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Another control session" }).waitFor();
  await second.getByRole("button", { name: "Give back and resume", exact: true }).click(); await finished(screenCase.threadId); await second.close();
  await page.goto(`${base}/bots/${normalBot}?screen=true`);
  await page.getByRole("button", { name: "Take control", exact: true }).click();
  await page.getByRole("button", { name: "Give back", exact: true }).click();
  await page.getByRole("button", { name: "Take control", exact: true }).waitFor();
  assert.equal((await owner.query(api.threads.timeline, { threadId: normalThread })).runs.at(-1)?.handoff, null);
  assert.equal(executions, 0);
  for (const [name, viewport, dark] of [
    ["desktop-light", { width: 1440, height: 1000 }, false], ["desktop-dark", { width: 1440, height: 1000 }, true],
    ["phone-light", { width: 390, height: 844 }, false], ["phone-dark", { width: 390, height: 844 }, true],
  ] as const) {
    const shot = await ui.newPage({ viewport, colorScheme: dark ? "dark" : "light" });
    shot.setDefaultTimeout(15000);
    await shot.goto(`${base}/bots/${blocked[2]!.botId}`);
    await shot.getByRole("button", { name: "Resume bot", exact: true }).waitFor();
    await shot.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(dark ? "dark" : "light")}`);
    await shot.screenshot({ path: join(output, `${name}-card.png`), animations: "disabled" });
    await shot.getByRole("button", { name: "Open screen", exact: true }).click();
    await shot.getByRole("button", { name: "Take control", exact: true }).waitFor();
    await shot.screenshot({ path: join(output, `${name}-viewer.png`), animations: "disabled" }); await shot.close();
  }
  assert.equal(errors.length, 0, errors.join("\n"));
  assert(!JSON.stringify(models).includes(secret));
  for (const item of blocked) assert(!JSON.stringify(await owner.query(api.threads.timeline, { threadId: item.threadId })).includes(secret));
  console.log("ok Chromium/noVNC/RFB private input; minimize/close/reload/drop/expiry keep pending; ordinary manual takeover; two-tab completion; session-bound give-back/resume; phone/desktop light/dark screenshots; secret absent from events/model requests");
  for (const item of blocked) await owner.mutation(api.runs.requestCancel, { runId: item.runId });
} finally {
  await ui?.close(); stopLink();
  for (const socket of tcpClients) socket.destroy();
  for (const tcp of tcpServers) await new Promise<void>(r => tcp.close(() => r()));
  await stop(); await new Promise<void>(r => model.close(() => r()));
}
assert(!(await readFile(logPath, "utf8")).includes(secret));
console.log("PASS handoff verification. RFB fixture models desktop input; real-site authentication and systemd desktop cookie transfer are not established here.");
