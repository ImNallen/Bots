import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { api } from "@bots/convex";
import type { Id } from "@bots/convex/dataModel";
import { isBrowserInvocation, pageView, type BrowserInvocation, type ToolInvocation } from "@bots/protocol";
import { ConvexHttpClient } from "convex/browser";
import { importJWK, SignJWT } from "jose";
import { chromium } from "playwright";
import { createBrowser, webSocketConnector, type Cdp } from "../apps/computerd/src/browser.ts";
import { openJournal } from "../apps/computerd/src/journal.ts";
import { createCalls } from "../apps/computerd/src/calls.ts";
import { connectLink } from "../apps/computerd/src/link.ts";
import { runTool, type RunnerDeps } from "../apps/orchestrator/src/runner.ts";
import { encryptApiKey } from "../apps/orchestrator/src/secrets.ts";
import { paths, parsePrivateJwk, readEnvFile } from "./lib.ts";

const env = readEnvFile(paths.rootEnv);
env.COMPUTER_TOKEN = randomBytes(32).toString("base64url");
env.DEV_LOGIN = `page-proof-${randomUUID()}@example.test`;
assert.ok(env.CONVEX_URL);
assert.ok(env.CONVEX_URL.startsWith("http://127.0.0.1:"));
assert.notEqual(new URL(env.CONVEX_URL).port, "3210", "Use a disposable backend, never the shared dev backend");
assert.equal(readEnvFile(paths.convexEnv).CONVEX_SELF_HOSTED_URL, env.CONVEX_URL);
assert.ok(env.JWT_PRIVATE_JWK && env.JWT_ISSUER && env.MASTER_KEY && env.DEV_LOGIN && env.COMPUTER_TOKEN && env.PORT && env.LINK_PORT);
const jwk = parsePrivateJwk(env.JWT_PRIVATE_JWK);
const key = await importJWK(jwk, "ES256");
async function client(subject: string) {
  const token = await new SignJWT({ email: env.DEV_LOGIN, name: "Page proof" }).setProtectedHeader({ alg: "ES256", kid: jwk.kid }).setIssuer(env.JWT_ISSUER!).setAudience("bots").setSubject(subject).setIssuedAt().setExpirationTime("1h").sign(key);
  const value = new ConvexHttpClient(env.CONVEX_URL!); value.setAuth(token); return value;
}
const service = await client("service:orchestrator");
const owner = await client(`dev:${env.DEV_LOGIN}`);
const user = await owner.mutation(api.users.ensureCurrent, {});
await service.mutation(api.credentials.store, { ownerId: user._id, ...encryptApiKey({ masterKey: Buffer.from(env.MASTER_KEY, "base64"), ownerId: user._id, apiKey: "scripted-only" }) });
const wait = async <T>(probe: () => Promise<T | null>, label: string): Promise<T> => {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { const value = await probe(); if (value !== null) return value; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw Error(`Timed out: ${label}`);
};
const serve = async (server: ReturnType<typeof createServer>) => {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string"); return address.port;
};
const reserve = async () => { const server = createServer(); const port = await serve(server); await new Promise<void>(resolve => server.close(() => resolve())); return port; };
const siteServer = createServer((_req, res) => res.end(`<!doctype html><title>Policy proof</title><input aria-label="Draft" id="draft"><button id="act" type="button">Commit</button><script>window.actions=0;window.edits=0;draft.oninput=()=>edits++;act.onclick=()=>actions++;</script>`));
const site = `http://127.0.0.1:${await serve(siteServer)}`;
const cdpPort = await reserve();
const engine = await chromium.launchServer({ headless: true, args: [`--remote-debugging-port=${cdpPort}`] });
const inspector = await webSocketConnector(cdpPort);
const transports: Cdp[] = [];
const browser = createBrowser({ desktops: { acquire: async () => ({ slot: 1, cdpPort, release() {} }) }, connector: async port => { const c = await webSocketConnector(port); transports.push(c); return c; } });
let session = "";
const evaluate = async (expression: string) => (await inspector.send("Runtime.evaluate", { expression, returnByValue: true }, session)).result as { value: unknown };
const direct = async (tool: BrowserInvocation) => browser.execute({ botId: "policy-fixture", tool, browsing: undefined, signal: AbortSignal.timeout(15000) });
const capture = async () => {
  const result = await direct({ name: "browser_navigate", args: { url: site } }); assert.equal(result.outcome, "ok", result.output);
  const { targetInfos } = await inspector.send("Target.getTargets"); assert.ok(Array.isArray(targetInfos));
  const target = targetInfos.find(target => target.url === site + "/"); assert.ok(target);
  session = String((await inspector.send("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId);
  return result;
};
const journalDir = await mkdtemp(join(tmpdir(), "bots-page-policy-"));
let dispatches = 0;
const calls = createCalls({ journal: await openJournal({ dir: journalDir }), execute: async args => {
  dispatches++;
  assert.ok(isBrowserInvocation(args.tool));
  return browser.execute({ ...args, tool: args.tool });
} });
const deps: RunnerDeps = {
  service: { query: service.query.bind(service), mutation: service.mutation.bind(service), subscribe: () => { throw Error("unexpected subscription"); } },
  slotFor: () => ({ release() {}, reclaim() {} }),
  link: { call: async args => calls.call(args), isConnected: () => true, disconnect() {}, sendBrowsingEnd() {}, openStream: async () => "no-computer" },
  search: async () => { throw Error("unexpected search"); }, masterKey: Buffer.from(env.MASTER_KEY, "base64"),
  mistral: { baseUrl: "http://127.0.0.1:1", model: "fixture" }, together: { baseUrl: "http://127.0.0.1:1", model: "fixture" }, ownerScope: user._id, log() {},
};
const lease = { lost: new AbortController().signal, cancel: new AbortController().signal, stop() {} };
const fixture = async (name: string, args: object) => {
  const botId = await owner.mutation(api.bots.create, { name: "Page authorization proof" });
  const threadId = await owner.mutation(api.threads.ensureForBot, { botId });
  const runId = await owner.mutation(api.threads.send, { threadId, text: "Manual crash fixture" });
  const claim = await service.mutation(api.runs.claim, { runId }); assert.equal(claim.kind, "claimed"); if (claim.kind !== "claimed") throw Error("claim");
  const captured = await capture(); const page = pageView.parse(captured.page);
  const call = { id: randomUUID(), name, arguments: JSON.stringify(args) };
  await service.mutation(api.runs.append, { runId, leaseToken: claim.leaseToken, expectedSeq: claim.nextSeq, body: { kind: "toolResult", toolCallId: "snapshot", name: "browser_snapshot", outcome: "ok", output: captured.output, truncated: false, page: JSON.stringify(page), screen: { view: JSON.stringify({ width: 1, height: 1, windows: [], active: null, marks: [], unlisted: 0, silent: [] }), image: { mediaType: "image/png", bytes: new Uint8Array([1,2,3]).buffer } } } });
  await service.mutation(api.runs.append, { runId, leaseToken: claim.leaseToken, expectedSeq: claim.nextSeq + 1, body: { kind: "assistantTurn", text: "", toolCalls: [call], model: "fixture", usage: { promptTokens: 0, completionTokens: 0 } } });
  return { botId, threadId, runId, claim, call, page, execute: () => runTool({ deps, runId, claim, lease, call, readUntrusted: true }), finish: () => service.mutation(api.runs.finish, { runId, leaseToken: claim.leaseToken, state: { kind: "done" } }) };
};
const pending = (threadId: Id<"threads">) => wait(async () => (await owner.query(api.approvals.pendingForThread, { threadId }))[0] ?? null, "approval");
let child: ChildProcess | undefined;
let stopLink = () => {};
let ui: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const modelSteps: { name: string; args: object }[] = [];
const model = createServer(async (req, res) => {
  for await (const _chunk of req) {}
  const next = modelSteps.shift();
  res.setHeader("Content-Type", "text/event-stream");
  const delta = next ? { role: "assistant", tool_calls: [{ index: 0, id: randomUUID(), function: { name: next.name, arguments: JSON.stringify(next.args) } }] } : { role: "assistant", content: "Fixture complete" };
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: next ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
});
try {
  let f = await fixture("browser_type", { ref: 1, text: "Automatic fill" });
  const filled = await f.execute(); assert.equal(filled.kind, "toolResult"); if (filled.kind !== "toolResult") throw Error("result"); assert.equal(filled.outcome, "ok", JSON.stringify(filled));
  assert.equal((await evaluate("draft.value")).value, "Automatic fill");
  assert.equal((await owner.query(api.approvals.pendingForThread, { threadId: f.threadId })).length, 0);
  await f.finish(); console.log("ok actual runner+Convex+computer: Automatic plain fill, zero approvals");
  f = await fixture("browser_type", { ref: 1, text: "After takeover" });
  const controlGrant1 = await owner.mutation(api.bots.takeOver, { botId: f.botId, action: { kind: "acquire" } });
  const blocked = f.execute();
  await new Promise(resolve => setTimeout(resolve, 150));
  await evaluate("draft.readOnly=true");
  await owner.mutation(api.bots.releaseTakeover, { botId: f.botId, sessionId: controlGrant1.sessionId });
  const blockedResult = await blocked; assert.ok("outcome" in blockedResult); assert.equal(blockedResult.outcome, "error");
  assert.equal((await evaluate("draft.value")).value, ""); await f.finish();
  console.log("ok takeover wait retains original aim and changed control refuses");
  f = await fixture("browser_click", { ref: 2 });
  await assert.rejects(service.mutation(api.approvals.request, { runId: f.runId, leaseToken: "lost", toolCallId: f.call.id, toolName: f.call.name, pageAim: JSON.stringify({ snapshotId: f.page.snapshotId }) }));
  const waiting = f.execute(); const approval = await pending(f.threadId);
  assert.match(approval.subject ?? "", /"Commit"/); assert.ok(approval.subject?.includes(site));
  assert.equal(await owner.query(api.screens.forApproval, { approvalId: approval._id }), null);
  const original = await service.query(api.approvals.forCall, { runId: f.runId, toolCallId: f.call.id }); assert.ok(original?.pageAim);
  const dedup = await service.mutation(api.approvals.request, { runId: f.runId, toolCallId: f.call.id, toolName: f.call.name, pageAim: "forged", subject: "forged" });
  assert.equal(dedup.pageAim, original.pageAim);
  await assert.rejects(owner.query(api.approvals.forCall, { runId: f.runId, toolCallId: f.call.id }));
  await evaluate("act.textContent='Changed during approval'");
  await owner.mutation(api.approvals.decide, { approvalId: approval._id, decision: "approved" });
  const stale = await waiting; assert.equal(stale.kind, "toolResult"); if (stale.kind !== "toolResult") throw Error("result"); assert.equal(stale.outcome, "error"); assert.equal((await evaluate("actions")).value, 0);
  await service.mutation(api.runs.append, { runId: f.runId, leaseToken: f.claim.leaseToken, expectedSeq: f.claim.nextSeq + 2, body: stale });
  assert.equal(await service.query(api.pages.ofRun, { runId: f.runId }), null);
  await f.finish(); console.log("ok canonical aim, subject/site, screenshot exclusion, pending mutation refusal and stale-page clearing");
  f = await fixture("browser_click", { ref: 2 });
  const deniedWait = f.execute(); const denied = await pending(f.threadId);
  await owner.mutation(api.approvals.decide, { approvalId: denied._id, decision: "denied" });
  const deniedResult = await deniedWait; assert.ok("outcome" in deniedResult); assert.equal(deniedResult.outcome, "denied");
  const before = dispatches;
  await owner.mutation(api.bots.setApprovalLevel, { botId: f.botId, level: "nothing" });
  execFileSync("pnpm", ["exec", "convex", "run", "pageChecks:expireLease", JSON.stringify({ runId: f.runId })], { cwd: paths.convexDir, stdio: "pipe" });
  const reclaimed = await service.mutation(api.runs.claim, { runId: f.runId }); assert.equal(reclaimed.kind, "claimed");
  if (reclaimed.kind !== "claimed") throw Error("reclaim");
  const replay = await runTool({ deps, runId: f.runId, claim: reclaimed, lease, call: f.call, readUntrusted: true });
  assert.ok("outcome" in replay); assert.equal(replay.outcome, "denied"); assert.equal(dispatches, before);
  await service.mutation(api.runs.finish, { runId: f.runId, leaseToken: reclaimed.leaseToken, state: { kind: "done" } });
  console.log("ok denial -> crash before append -> level nothing -> reclaimed same call: zero dispatch");
  f = await fixture("browser_click", { ref: 2 });
  const old = await service.mutation(api.approvals.request, { runId: f.runId, toolCallId: f.call.id, toolName: f.call.name });
  await owner.mutation(api.approvals.decide, { approvalId: old.approvalId, decision: "approved" });
  const beforeOld = dispatches; const oldResult = await f.execute(); assert.ok("outcome" in oldResult); assert.equal(oldResult.outcome, "invalid"); assert.equal(dispatches, beforeOld);
  await f.finish(); console.log("ok old approved aimless browser row cannot rebind");

  const modelPort = await serve(model);
  modelSteps.push(
    { name: "browser_navigate", args: { url: site } },
    { name: "browser_press", args: { key: "Tab" } },
    { name: "browser_snapshot", args: {} },
    { name: "browser_type", args: { ref: 1, text: "Pipeline" } },
    { name: "browser_click", args: { ref: 2 } },
    { name: "browser_press", args: { key: "Enter" } },
  );
  const origin = `http://127.0.0.1:${env.PORT}`;
  child = spawn(process.execPath, ["--env-file=.env.local", "apps/orchestrator/src/main.ts"], { cwd: paths.repoRoot, env: { ...process.env, DEV_LOGIN: env.DEV_LOGIN, COMPUTER_TOKEN: env.COMPUTER_TOKEN, MISTRAL_BASE_URL: `http://127.0.0.1:${modelPort}`, TOGETHER_BASE_URL: `http://127.0.0.1:${modelPort}` }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", data => process.stdout.write(data)); child.stderr?.on("data", data => process.stderr.write(data));
  await wait(async () => fetch(`${origin}/auth/token`).then(r => r.ok ? true : null).catch(() => null), "orchestrator");
  stopLink = connectLink({ url: `ws://127.0.0.1:${env.LINK_PORT}`, token: env.COMPUTER_TOKEN, calls, openScreen: () => { throw Error("browser card opened a desktop stream"); }, endBrowsing: (botId, key) => { void browser.endBrowsing(botId, key); } });
  const botId = await owner.mutation(api.bots.create, { name: "Page pipeline proof" });
  const threadId = await owner.mutation(api.threads.ensureForBot, { botId });
  await owner.mutation(api.threads.send, { threadId, text: "Run browser page policy fixture" });
  const clickCard = await pending(threadId); assert.match(clickCard.subject ?? "", /Click "Commit"/);
  assert.ok(clickCard.reason?.trim(), "the click approval must explain why it asks");
  ui = await chromium.launch({ headless: true });
  const tab = await ui.newPage();
  let screenQueries = 0;
  tab.on("websocket", socket => socket.on("framesent", frame => {
    if (String(frame.payload).includes("screens:forApproval")) screenQueries++;
  }));
  await tab.goto(`${origin}/bots/${botId}`);
  await tab.getByRole("button", { name: "Approve", exact: true }).waitFor();
  assert.ok((await tab.locator("body").innerText()).includes(`Click "Commit" on ${site}`));
  assert.equal(await tab.locator(".ask img").count(), 0);
  assert.equal(screenQueries, 0, "browser card must not subscribe to desktop screenshots");
  const outputDir = process.env.VERIFY_OUTPUT_DIR ?? tmpdir();
  await mkdir(outputDir, { recursive: true });
  await tab.screenshot({ path: join(outputDir, "browser-card.png") });
  await tab.getByRole("button", { name: "Approve", exact: true }).click();
  const enterCard = await wait(async () => (await owner.query(api.approvals.pendingForThread, { threadId })).find(row => row._id !== clickCard._id) ?? null, "Enter approval"); assert.match(enterCard.subject ?? "", /Press Enter/);
  await owner.mutation(api.approvals.decide, { approvalId: enterCard._id, decision: "approved" });
  await wait(async () => {
    const timeline = await owner.query(api.threads.timeline, { threadId });
    return timeline.runs.every(run => run.state.kind === "done") ? timeline : null;
  }, "pipeline finish");
  assert.equal((await evaluate("draft.value")).value, "Pipeline");
  assert.equal((await evaluate("actions")).value, 1);
  const timeline = await owner.query(api.threads.timeline, { threadId });
  const results = timeline.runs.flatMap(run => run.events.map(event => event.body)).filter(body => body.kind === "toolResult");
  const keyResults = results.filter(body => body.name === "browser_press");
  assert.deepEqual(keyResults.map(result => result.outcome), ["error", "error"]);
  for (const result of keyResults) assert.match(result.output, /browser keys cannot bind safely/i);
  console.log("ok captured Tab reaches the browser without approval; fill, click and Enter follow their approval rules");
  await direct({ name: "browser_navigate", args: { url: `${origin}/bots/${botId}` } });
  const appPage = await wait(async () => {
    const result = await direct({ name: "browser_snapshot", args: {} });
    return result.page?.targets.some(target => target.words === "Message") ? result.page : null;
  }, "React composer");
  const target = appPage.targets.find(target => target.words === "Message"); assert.ok(target);
  const appResult = await direct({ name: "browser_type", args: { ref: target.ref, text: "Native React draft", submit: false }, aim: { kind: "element", snapshotId: appPage.snapshotId, origin: appPage.origin, target } });
  assert.equal(appResult.outcome, "ok", appResult.output);
  assert.equal((await evaluate("document.querySelector('textarea').value")).value, "Native React draft");
  assert.equal((await evaluate("document.querySelector('button[aria-label=Send]').disabled")).value, false, "React must observe the edit and enable Send");
  console.log("ok production edit accepted by Bots React 19 controlled composer and enabled Send");
  console.log("verify:page-policy passed");
} finally {
  stopLink();
  child?.kill("SIGTERM");
  await ui?.close(); inspector.close(); transports.forEach(c => c.close()); await engine.close();
  siteServer.close(); model.close(); await rm(journalDir, { recursive: true, force: true });
}
