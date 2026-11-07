import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { api } from "@bots/convex";
import type { Id } from "@bots/convex/dataModel";
import { ConvexHttpClient } from "convex/browser";
import { chromium } from "playwright";
import { attachmentRoutes } from "../apps/orchestrator/src/attachments.ts";
import { identityFor } from "../apps/orchestrator/src/auth.ts";
import { parseConfig } from "../apps/orchestrator/src/config.ts";
import { createTokenIssuer } from "../apps/orchestrator/src/tokens.ts";
import { paths, readEnvFile, runConvex } from "./lib.ts";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert(address && typeof address !== "string");
  return address.port;
}
async function freePort() {
  const server = createServer(); const port = await listen(server);
  await new Promise<void>((resolve) => server.close(() => resolve())); return port;
}
async function until(probe: () => Promise<boolean>, message: string) {
  const limit = Date.now() + 20_000;
  while (Date.now() < limit) {
    if (await probe().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(message);
}
const requests: string[] = [];
const fake = createServer(async (request, response) => {
  if (request.url === "/v1/models") { response.writeHead(200, { "Content-Type": "application/json" }); response.end('{"data":[]}'); return; }
  if (request.url !== "/v1/chat/completions") { response.writeHead(404); response.end(); return; }
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  requests.push(Buffer.concat(chunks).toString("utf8"));
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.end(`data: ${JSON.stringify({ model: "attachment-check", choices: [{ delta: { content: "I received your files." }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`);
});
const fakePort = await listen(fake);
const port = await freePort(), linkPort = await freePort();
const login = `verify-attachments-${Date.now()}@localhost`;
const env = { ...process.env, ...readEnvFile(paths.rootEnv), AUTH_MODE: "dev", DEV_LOGIN: login, PORT: String(port), LINK_PORT: String(linkPort), LINK_HOST: "127.0.0.1", COMPUTER_TOKEN: randomBytes(32).toString("base64url"), MISTRAL_BASE_URL: `http://127.0.0.1:${fakePort}`, PROXMOX_URL: "", PROXMOX_NODE: "", PROXMOX_TOKEN: "", PROXMOX_CA_FILE: "" };
const config = parseConfig(env);
const issuer = await createTokenIssuer(config);
const owner = identityFor({ provider: "dev", login });
const client = new ConvexHttpClient(config.convexUrl, { logger: false });
client.setAuth((await issuer.forUser(owner)).token);
const service = new ConvexHttpClient(config.convexUrl, { logger: false });
service.setAuth((await issuer.forService()).token);
const logs: string[] = [];
const child = spawn(process.execPath, [paths.orchestratorMain], { env, stdio: ["ignore", "pipe", "pipe"] });
child.stdout.on("data", (data: Buffer) => logs.push(data.toString()));
child.stderr.on("data", (data: Buffer) => logs.push(data.toString()));
const base = `http://127.0.0.1:${port}`;
const output = process.env.DESIGN_SCREENSHOTS ?? "/tmp/bots-attachment-review";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(15_000);
const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
const bots: Id<"bots">[] = [];
const image = { name: "screenshot.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6zXcAAAAASUVORK5CYII=", "base64") };
const text = { name: "notes.md", mimeType: "text/markdown", buffer: Buffer.from("The launch code is AURORA-184.\nMeet at the café at 10.") };

async function upload(botId: Id<"bots">, file = text) {
  const response = await fetch(`${base}/api/attachments/${botId}`, { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(file.name), "X-File-Type": file.mimeType }, body: file.buffer });
  assert.equal(response.status, 201, await response.clone().text());
  const body: unknown = await response.json();
  assert(typeof body === "object" && body !== null && "id" in body && typeof body.id === "string");
  const ready = await client.query(api.attachments.draft, { id: body.id, botId }); assert(ready); return ready;
}
async function idle(botId: Id<"bots">) { await until(async () => await client.query(api.threads.activeRun, { botId }) === null, "The fixture run did not finish."); }
function storageUrlForCheck(storageId: string): string {
  const result = runConvex(["run", "attachmentChecks:storageForCheck", JSON.stringify({ storageId })]);
  assert(result.kind === "ok", result.kind === "failed" ? result.output : "");
  const body: unknown = JSON.parse(result.stdout);
  assert(typeof body === "object" && body !== null && "url" in body && typeof body.url === "string");
  return body.url;
}

try {
  await until(async () => (await fetch(`${base}/healthz`)).ok, "The test orchestrator did not start.");
  await client.mutation(api.users.ensureCurrent, {});
  const botId = await client.mutation(api.bots.create, { name: "Atlas", color: "green", shape: "ball" }); bots.push(botId);
  const otherBot = await client.mutation(api.bots.create, { name: "Scout", color: "blue", shape: "ball" }); bots.push(otherBot);
  const threadId = await client.mutation(api.threads.ensureForBot, { botId });
  assert.equal((await fetch(`${base}/api/mistral-key`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: "attachment-check-key" }) })).status, 200);
  await mkdir(output, { recursive: true });
  await page.goto(`${base}/bots/${botId}`); await page.locator("#message").waitFor();
  assert(await page.getByRole("button", { name: "Send", exact: true }).isDisabled());
  const chooser = page.waitForEvent("filechooser"); await page.getByRole("button", { name: "Attach files", exact: true }).click();
  await (await chooser).setFiles([image, text]);
  await until(async () => await page.locator('.attachment-draft[data-state="ready"]').count() === 2, "Files did not upload.");
  assert(await page.getByRole("button", { name: "Send", exact: true }).isEnabled(), "Files can be sent without message text.");
  await page.screenshot({ path: `${output}/desktop-drafts-light.png` });
  await page.locator("#message").fill("Review these files.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.locator(".assistant-message").getByText("I received your files.", { exact: true }).waitFor(); await idle(botId);
  assert.equal(requests.length, 1);
  assert(requests[0]?.includes('"type":"image_url"') && requests[0].includes(image.buffer.toString("base64")));
  assert(requests[0]?.includes("AURORA-184") && requests[0].includes("Attached file: notes.md"));
  assert.equal(await page.locator(".attachment-draft").count(), 0);
  assert.equal(await page.locator(".message-attachment").count(), 2);
  const timeline = await client.query(api.threads.timeline, { threadId });
  const files = timeline.runs.flatMap((run) => run.events.flatMap((event) => event.body.kind === "userMessage" ? event.body.attachments ?? [] : []));
  const sentImage = files.find((file) => file.name === image.name), sentText = files.find((file) => file.name === text.name); assert(sentImage && sentText);
  const download = await fetch(`${base}/api/attachments/${sentText.id}`);
  assert.equal(await download.text(), text.buffer.toString());
  assert.match(download.headers.get("content-disposition") ?? "", /^attachment;/);
  assert.match(download.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(download.headers.get("x-content-type-options"), "nosniff");
  assert.equal(download.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.equal((await fetch(`${base}/api/attachments/${sentImage.id}?preview=1`)).headers.get("content-type"), "image/png");
  assert.equal((await fetch(`${base}/api/attachments/${sentImage.id}`, { headers: { "X-Forwarded-For": "198.51.100.2" } })).status, 403);
  await page.reload(); await page.locator('.message-attachment img').waitFor();
  await page.waitForFunction("document.querySelector('.message-attachment img')?.naturalWidth > 0");
  await assert.rejects(client.mutation(api.attachments.discard, { id: sentText.id }), /already part/);
  await assert.rejects(client.mutation(api.threads.send, { threadId, text: "Reuse a sent file", attachmentIds: [sentText.id] }), /unavailable/);

  const foreign = await upload(otherBot);
  await assert.rejects(client.mutation(api.threads.send, { threadId, text: "Wrong bot", attachmentIds: [foreign.id] }), /unavailable/);
  const stranger = new ConvexHttpClient(config.convexUrl, { logger: false });
  const strangerIdentity = identityFor({ provider: "dev", login: `stranger-${login}` });
  stranger.setAuth((await issuer.forUser(strangerIdentity)).token); await stranger.mutation(api.users.ensureCurrent, {});
  assert.equal(await stranger.query(api.attachments.draft, { id: foreign.id, botId: otherBot }), null);
  await assert.rejects(stranger.mutation(api.attachments.discard, { id: foreign.id }), /not found/);
  await assert.rejects(client.query(api.attachments.downloadForService, { id: sentText.id, subject: owner.subject }), /Not authorized/);
  assert.equal(await service.query(api.attachments.downloadForService, { id: sentText.id, subject: strangerIdentity.subject }), null);
  await assert.rejects(new ConvexHttpClient(config.convexUrl, { logger: false }).query(api.attachments.draft, { id: foreign.id, botId: otherBot }), /Not authenticated/);
  const tailscale = attachmentRoutes({ authMode: { kind: "tailscale" }, service: { query: (fn, ...args) => service.query(fn, ...args), mutation: (fn, ...args) => service.mutation(fn, ...args) } });
  assert.equal((await tailscale.request(`http://localhost/${sentText.id}`)).status, 401);
  assert.equal((await tailscale.request(`http://localhost/${sentText.id}`, { headers: { "tailscale-user-login": strangerIdentity.email } })).status, 404);

  const pdf = { name: "brief.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n") };
  await page.locator('input[type="file"]').setInputFiles(pdf);
  await page.locator('.attachment-draft[data-state="ready"]').waitFor();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await until(async () => requests.length === 2, "The file-only message did not reach the model."); await idle(botId);
  assert(requests[1]?.includes(`data:application/pdf;base64,${pdf.buffer.toString("base64")}`));

  const bulk = [];
  for (let index = 0; index < 5; index++) bulk.push(await upload(botId, { ...text, name: `bulk-${index}.txt` }));
  await assert.rejects(client.mutation(api.threads.send, { threadId, text: "Too many", attachmentIds: bulk.map((file) => file.id) }), /up to four/);
  const firstBulk = bulk[0]; assert(firstBulk);
  await assert.rejects(client.mutation(api.threads.send, { threadId, text: "Repeated ID", attachmentIds: [firstBulk.id, firstBulk.id] }), /different files/);
  await client.mutation(api.threads.send, { threadId, text: "Four files", attachmentIds: bulk.slice(0, 4).map((file) => file.id) });
  await until(async () => requests.length === 3, "A four-file message did not reach the model."); await idle(botId);
  for (let index = 0; index < 4; index++) assert(requests[2]?.includes(`bulk-${index}.txt`));
  const fifthBulk = bulk[4]; assert(fifthBulk); await client.mutation(api.attachments.discard, { id: fifthBulk.id });

  const intercepted = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  await page.route(`**/api/attachments/${botId}`, async (route) => { intercepted.resolve(); await release.promise; await route.continue(); });
  await page.locator('input[type="file"]').setInputFiles(text);
  await intercepted.promise;
  try { assert(await page.getByRole("button", { name: "Send", exact: true }).isDisabled(), "Sending waits until uploads finish."); } finally { release.resolve(); }
  await page.locator('.attachment-draft[data-state="ready"]').waitFor();
  await page.unroute(`**/api/attachments/${botId}`);
  await page.getByRole("button", { name: `Remove ${text.name}`, exact: true }).click();

  let fail = true;
  await page.route(`**/api/attachments/${botId}`, async (route) => {
    if (fail) { fail = false; await route.fulfill({ status: 503, json: { error: "Upload interrupted. Try again." } }); }
    else await route.continue();
  });
  await page.locator('input[type="file"]').setInputFiles(text);
  await page.getByRole("button", { name: "Retry upload", exact: true }).waitFor();
  await page.locator("#message").fill("A draft survives upload errors.");
  assert(await page.getByRole("button", { name: "Send", exact: true }).isDisabled());
  await page.getByRole("button", { name: "Retry upload", exact: true }).click();
  await page.locator('.attachment-draft[data-state="ready"]').waitFor();
  await page.unroute(`**/api/attachments/${botId}`);
  assert.equal(await page.locator("#message").inputValue(), "A draft survives upload errors.");
  await page.getByRole("button", { name: `Remove ${text.name}`, exact: true }).click();
  assert.equal(await page.locator(".attachment-draft").count(), 0);
  await page.locator("#message").fill("");
  assert(await page.getByRole("button", { name: "Send", exact: true }).isDisabled());

  await page.evaluate(`(() => {
    const target = document.querySelector(".composer");
    const files = new DataTransfer(); files.items.add(new File(["dropped text"], "dropped.txt", { type: "text/plain" }));
    target?.dispatchEvent(new DragEvent("drop", { dataTransfer: files, bubbles: true, cancelable: true }));
  })()`);
  await page.locator('.attachment-draft[data-state="ready"]').waitFor();
  await page.getByRole("button", { name: "Remove dropped.txt", exact: true }).click();
  await page.evaluate(`(() => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(image.buffer.toString("base64"))}), (c) => c.charCodeAt(0));
    const data = new DataTransfer(); data.items.add(new File([bytes], "pasted.png", { type: "image/png" }));
    document.querySelector("#message")?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  })()`);
  await page.locator('.attachment-draft[data-state="ready"]').waitFor();
  await page.locator('input[type="file"]').setInputFiles([text, { ...text, name: "second.txt" }, { ...text, name: "third.txt" }]);
  await until(async () => await page.locator('.attachment-draft[data-state="ready"]').count() === 4, "Four files did not upload.");
  assert(await page.getByRole("button", { name: "Attach files", exact: true }).isDisabled());
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate("document.documentElement.dataset.theme='dark'");
  assert.equal(await page.evaluate("document.documentElement.scrollWidth > innerWidth"), false);
  await page.screenshot({ path: `${output}/phone-drafts-dark.png` });
  await page.setViewportSize({ width: 390, height: 600 });
  const sendBox = await page.getByRole("button", { name: "Send", exact: true }).boundingBox();
  assert(sendBox && sendBox.y + sendBox.height <= 600, "The attachment list must leave the send control visible on a short phone screen.");
  await page.setViewportSize({ width: 390, height: 844 });
  const draftFiles = await page.locator(".attachment-draft").count(); assert.equal(draftFiles, 4);
  while (await page.getByRole("button", { name: /^Remove / }).count() > 0) await page.getByRole("button", { name: /^Remove / }).first().click();
  const oversized = { name: "large.txt", mimeType: "text/plain", buffer: Buffer.alloc(256 * 1024 + 1, 65) };
  await page.locator('input[type="file"]').setInputFiles(oversized); await page.getByRole("alert").filter({ hasText: "too large" }).waitFor();
  assert.equal(await page.locator(".attachment-draft").count(), 0);
  const bad = await fetch(`${base}/api/attachments/${botId}`, { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-File-Name": "fake.png", "X-File-Type": "image/png" }, body: "not a PNG" });
  assert.equal(bad.status, 400);
  const crossOrigin = await fetch(`${base}/api/attachments/${botId}`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "ignored" }); assert.equal(crossOrigin.status, 415);
  const expiring = await upload(botId);
  const expired = runConvex(["run", "attachments:expire", JSON.stringify({ id: expiring.id })]); assert.equal(expired.kind, "ok");
  assert.equal(await client.query(api.attachments.draft, { id: expiring.id, botId }), null);
  const kept = runConvex(["run", "attachments:expire", JSON.stringify({ id: sentText.id })]); assert.equal(kept.kind, "ok");
  const stored = await service.query(api.attachments.downloadForService, { id: sentText.id, subject: owner.subject }); assert(stored?.url);
  const invalidTicket = await service.mutation(api.attachments.beginForService, { botId, subject: owner.subject, name: "mismatch.txt", contentType: "text/plain", size: 2 });
  const invalidUpload = await fetch(invalidTicket.uploadUrl, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "three" });
  const invalidBody: unknown = await invalidUpload.json();
  assert(typeof invalidBody === "object" && invalidBody !== null && "storageId" in invalidBody && typeof invalidBody.storageId === "string");
  const invalidStorageUrl = storageUrlForCheck(invalidBody.storageId);
  assert.equal((await fetch(invalidStorageUrl)).status, 200);
  assert.equal((await service.mutation(api.attachments.completeForService, { id: invalidTicket.id, storageId: invalidBody.storageId })).kind, "failed");
  assert.equal((await fetch(invalidStorageUrl)).status, 404, "Failed upload completion must commit storage cleanup.");
  const validTicket = await service.mutation(api.attachments.beginForService, { botId, subject: owner.subject, name: "retry.txt", contentType: "text/plain", size: 5 });
  const validUpload = await fetch(validTicket.uploadUrl, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "hello" });
  const validBody: unknown = await validUpload.json();
  assert(typeof validBody === "object" && validBody !== null && "storageId" in validBody && typeof validBody.storageId === "string");
  for (let attempt = 0; attempt < 2; attempt++) assert.equal((await service.mutation(api.attachments.completeForService, { id: validTicket.id, storageId: validBody.storageId })).kind, "ready");
  assert.equal((await fetch(`${base}/api/attachments/${validTicket.id}`)).status, 200, "Repeated upload completion must preserve the file.");
  const raceTicket = await service.mutation(api.attachments.beginForService, { botId: otherBot, subject: owner.subject, name: "deleted-bot.txt", contentType: "text/plain", size: 5 });
  const raceUpload = await fetch(raceTicket.uploadUrl, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "hello" });
  const raceBody: unknown = await raceUpload.json();
  assert(typeof raceBody === "object" && raceBody !== null && "storageId" in raceBody && typeof raceBody.storageId === "string");
  const raceStorageUrl = storageUrlForCheck(raceBody.storageId);
  await client.mutation(api.bots.remove, { botId: otherBot });
  assert.equal((await service.mutation(api.attachments.completeForService, { id: raceTicket.id, storageId: raceBody.storageId })).kind, "failed");
  assert.equal((await fetch(raceStorageUrl)).status, 404, "An upload finishing after bot deletion must remove its stored file.");
  const storageUrl = stored.url;
  await client.mutation(api.bots.remove, { botId });
  await until(async () => !(await fetch(storageUrl)).ok, "Deleting the bot did not remove its stored files.");
  assert.equal((await fetch(`${base}/api/attachments/${sentText.id}`)).status, 404);
  assert.deepEqual(errors, []);
  console.log("verify:attachments passed: real storage and runner, image/text/PDF model chunks, file-only sending, previews, downloads, reload, retry, removal, drag/drop, paste, four-file limit, mobile layout, ownership, authentication, format checks, expiration, and bot deletion. Model answers use a fake endpoint.");
  console.log(`Screenshots: ${output}`);
} catch (error) {
  await mkdir(output, { recursive: true }); await page.screenshot({ path: `${output}/failure.png` }).catch(() => {});
  console.error(logs.join("").slice(-3500)); throw error;
} finally {
  await browser.close();
  for (const botId of bots) if (await client.query(api.bots.get, { botId })) await client.mutation(api.bots.remove, { botId });
  if (child.exitCode === null) { child.kill("SIGTERM"); await new Promise<void>((resolve) => child.once("exit", () => resolve())); }
  await new Promise<void>((resolve) => fake.close(() => resolve()));
}
