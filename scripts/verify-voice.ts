import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { api } from "@bots/convex";
import type { Id } from "@bots/convex/dataModel";
import { ConvexHttpClient } from "convex/browser";
import { chromium, firefox, type Page } from "playwright";
import { identityFor } from "../apps/orchestrator/src/auth.ts";
import { parseConfig } from "../apps/orchestrator/src/config.ts";
import { createTokenIssuer } from "../apps/orchestrator/src/tokens.ts";
import { voiceRoutes } from "../apps/orchestrator/src/voice.ts";
import { paths, readEnvFile } from "./lib.ts";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert(address && typeof address !== "string"); return address.port;
}
async function freePort() { const server = createServer(); const port = await listen(server); await new Promise<void>((resolve) => server.close(() => resolve())); return port; }
async function until(probe: () => Promise<boolean>, message: string) {
  const end = Date.now() + 20_000;
  while (Date.now() < end) { if (await probe().catch(() => false)) return; await new Promise((resolve) => setTimeout(resolve, 100)); }
  assert.fail(message);
}

type Mode = "ok" | "busy" | "empty" | "error" | "slow";
let mode: Mode = "ok";
let chatCalls = 0;
const audioCalls: { model: string; name: string; type: string; size: number; header: number[] }[] = [];
const gates = new Set<() => void>();
const fake = createServer(async (request, response) => {
  if (request.url === "/v1/models") { response.writeHead(200, { "Content-Type": "application/json" }); response.end('{"data":[]}'); return; }
  if (request.url === "/v1/chat/completions") {
    for await (const _ of request) { /* Drain the fixture request. */ }
    chatCalls++;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ model: "voice-check", choices: [{ delta: { content: "Draft sent." }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`); return;
  }
  if (request.url !== "/v1/audio/transcriptions") { response.writeHead(404); response.end(); return; }
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const data = await new Request("http://fixture/", { method: "POST", headers: { "Content-Type": request.headers["content-type"] ?? "" }, body: Buffer.concat(chunks) }).formData();
  const file = data.get("file"); assert(file instanceof File);
  assert.equal(request.headers.authorization, "Bearer voice-check-key");
  audioCalls.push({ model: String(data.get("model")), name: file.name, type: file.type, size: file.size, header: [...new Uint8Array(await file.arrayBuffer()).subarray(0, 12)] });
  const selected = mode;
  if (selected === "slow") await new Promise<void>((resolve) => { const done = () => { gates.delete(done); resolve(); }; gates.add(done); });
  if (response.destroyed) return;
  response.writeHead(selected === "busy" ? 429 : selected === "error" ? 500 : 200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(selected === "error" ? { error: "private upstream detail: voice-check-key" } : { text: selected === "empty" ? "" : "Meet at the café at ten." }));
});
const fakePort = await listen(fake), port = await freePort(), linkPort = await freePort();
const login = `verify-voice-${Date.now()}@localhost`;
const env = { ...process.env, ...readEnvFile(paths.rootEnv), AUTH_MODE: "dev", DEV_LOGIN: login, PORT: String(port), LINK_PORT: String(linkPort), LINK_HOST: "127.0.0.1", COMPUTER_TOKEN: randomBytes(32).toString("base64url"), MISTRAL_BASE_URL: `http://127.0.0.1:${fakePort}`, PROXMOX_URL: "", PROXMOX_NODE: "", PROXMOX_TOKEN: "", PROXMOX_CA_FILE: "" };
const config = parseConfig(env), issuer = await createTokenIssuer(config);
const owner = identityFor({ provider: "dev", login });
const client = new ConvexHttpClient(config.convexUrl, { logger: false }); client.setAuth((await issuer.forUser(owner)).token);
const service = new ConvexHttpClient(config.convexUrl, { logger: false }); service.setAuth((await issuer.forService()).token);
const logs: string[] = [];
const child = spawn(process.execPath, [paths.orchestratorMain], { env, stdio: ["ignore", "pipe", "pipe"] });
child.stdout.on("data", (data: Buffer) => logs.push(data.toString())); child.stderr.on("data", (data: Buffer) => logs.push(data.toString()));
const base = `http://127.0.0.1:${port}`;
const output = process.env.DESIGN_SCREENSHOTS ?? "/tmp/bots-voice-review";
const useFirefox = process.env.VOICE_BROWSER === "firefox";
const browser = useFirefox
  ? await firefox.launch({ firefoxUserPrefs: { "media.navigator.streams.fake": true, "media.navigator.permission.disabled": true, "media.autoplay.default": 5, "media.autoplay.block-webaudio": true, "media.autoplay.blocking_policy": 2 } })
  : await chromium.launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ...(!useFirefox ? { permissions: ["microphone"] } : {}) });
await context.addInitScript(`window.__voiceStreams = []; const originalMicrophone = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); navigator.mediaDevices.getUserMedia = async (...args) => { const stream = await originalMicrophone(...args); window.__voiceStreams.push(stream); return stream; };`);
await context.addInitScript(`window.__voiceAudioContexts = []; const OriginalAudioContext = window.AudioContext; window.AudioContext = class extends OriginalAudioContext { constructor(...args) { super(...args); window.__voiceAudioContexts.push(this); } };`);
const page = await context.newPage(); page.setDefaultTimeout(15_000);
const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
const bots: Id<"bots">[] = [];
const input = () => page.locator("#message");
const mic = () => page.getByRole("button", { name: "Start voice input", exact: true });
async function record(target: Page = page) {
  await target.getByRole("button", { name: "Start voice input", exact: true }).click();
  await target.locator('.voice-status[data-state="recording"]').waitFor();
  await target.waitForTimeout(350);
}
async function tracksStopped(target: Page = page) {
  await target.waitForFunction("window.__voiceStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended'))");
  await target.waitForFunction("window.__voiceAudioContexts.every(context => context.state === 'closed')");
}
function releaseTranscriptions() { for (const release of [...gates]) release(); }
const audioFixture = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, ...Array.from({ length: 20 }, () => 1)]);
async function postAudio(botId: string, body: Buffer = audioFixture, type = "audio/webm") { return fetch(`${base}/api/voice/${botId}`, { method: "POST", headers: { "Content-Type": type }, body }); }

try {
  await until(async () => (await fetch(`${base}/healthz`)).ok, "The voice test app did not start.");
  await client.mutation(api.users.ensureCurrent, {});
  const botId = await client.mutation(api.bots.create, { name: "Atlas", color: "green", shape: "ball" }); bots.push(botId);
  const otherBot = await client.mutation(api.bots.create, { name: "Scout", color: "blue", shape: "ball" }); bots.push(otherBot);
  const threadId = await client.mutation(api.threads.ensureForBot, { botId });
  await mkdir(output, { recursive: true });
  await page.goto(`${base}/bots/${botId}`); await input().waitFor();
  assert(await mic().isDisabled(), "Voice input waits for a Mistral key.");
  assert.equal((await postAudio(botId)).status, 400);
  assert.equal((await fetch(`${base}/api/mistral-key`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: "voice-check-key" }) })).status, 200);
  await until(() => mic().isEnabled(), "The microphone did not enable after saving a key.");
  await page.evaluate(`(async () => {
    const original = navigator.mediaDevices.getUserMedia;
    const audio = new AudioContext();
    document.addEventListener('click', () => void audio.resume(), { once: true, capture: true });
    const tone = audio.createOscillator(), volume = audio.createGain(), output = audio.createMediaStreamDestination();
    tone.frequency.value = 440; volume.gain.value = 0.004;
    tone.connect(volume).connect(output); tone.start();
    navigator.mediaDevices.getUserMedia = async () => { window.__voiceStreams.push(output.stream); return output.stream; };
    window.__finishQuietInput = async () => { navigator.mediaDevices.getUserMedia = original; tone.stop(); await audio.close(); };
    window.__silenceQuietInput = () => { volume.gain.value = 0; };
  })()`);
  await record();
  await page.waitForFunction("[...document.querySelectorAll('.voice-waveform > span')].some(bar => parseFloat(bar.style.height) >= 12)", null, { timeout: 5000 });
  await page.screenshot({ path: `${output}/desktop-quiet-microphone.png` });
  await page.evaluate("window.__silenceQuietInput()");
  await page.waitForFunction("[...document.querySelectorAll('.voice-waveform > span')].every(bar => parseFloat(bar.style.height) <= 4)", null, { timeout: 7000 });
  await page.getByRole("button", { name: "Cancel voice input", exact: true }).click();
  await page.evaluate("window.__finishQuietInput()"); await tracksStopped();
  await page.locator('input[type="file"]').setInputFiles({ name: "voice-note.txt", mimeType: "text/plain", buffer: Buffer.from("Keep this attachment with the dictated message.") });
  await page.locator('.attachment-draft[data-state="ready"]').waitFor();
  await input().fill("Keep this draft.");
  await record();
  assert.equal(await page.getByRole("button", { name: "Send", exact: true }).count(), 0, "Recording replaces the send toolbar with dedicated voice controls.");
  await page.waitForFunction("[...document.querySelectorAll('.voice-waveform > span')].some(bar => parseFloat(bar.style.height) > 4)");
  assert.equal(await page.getByRole("button", { name: "Finish recording", exact: true }).innerText(), "Done");
  await input().press("Enter"); assert.equal(chatCalls, 0, "Enter cannot send while recording.");
  await page.screenshot({ path: `${output}/desktop-recording-light.png` });
  await page.getByRole("button", { name: "Finish recording", exact: true }).click();
  await until(async () => await input().inputValue() === "Keep this draft. Meet at the café at ten.", "The transcript did not append to the draft.");
  await tracksStopped(); assert.equal(chatCalls, 0, "Transcription never sends the chat message automatically.");
  await page.getByText("Added to draft", { exact: true }).waitFor();
  assert.equal(await page.locator('.attachment-draft[data-state="ready"]').count(), 1, "Dictation preserves selected attachments.");
  const call = audioCalls[0]; assert(call && call.size > 16);
  assert.equal(call.model, config.transcriptionModel); assert.equal(call.type, "audio/webm"); assert.equal(call.name, "recording.webm");
  assert.deepEqual(call.header.slice(0, 4), [0x1a, 0x45, 0xdf, 0xa3]);
  assert.equal((await client.query(api.threads.timeline, { threadId })).runs.length, 0);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.locator(".assistant-message").getByText("Draft sent.", { exact: true }).waitFor();
  await until(async () => await client.query(api.threads.activeRun, { botId }) === null, "The fixture chat did not finish.");
  assert.equal(chatCalls, 1);
  const sent = await client.query(api.threads.timeline, { threadId });
  const message = sent.runs.flatMap((run) => run.events.map((event) => event.body)).find((body) => body.kind === "userMessage");
  assert(message?.kind === "userMessage" && message.attachments?.[0]?.name === "voice-note.txt");
  assert.equal(message.text, "Keep this draft. Meet at the café at ten.");
  await page.screenshot({ path: `${output}/desktop-idle-light.png` });

  await input().fill("Keep on cancel."); let before = audioCalls.length;
  await record(); await page.getByRole("button", { name: "Cancel voice input", exact: true }).click();
  await tracksStopped(); assert.equal(await input().inputValue(), "Keep on cancel."); assert.equal(audioCalls.length, before);
  mode = "busy"; await record(); await page.getByRole("button", { name: "Finish recording", exact: true }).click();
  await page.getByRole("button", { name: "Retry transcription", exact: true }).waitFor(); await tracksStopped();
  assert.equal(await input().inputValue(), "Keep on cancel."); assert.equal(await page.getByRole("button", { name: "Send", exact: true }).count(), 0);
  await page.screenshot({ path: `${output}/desktop-retry-light.png` });
  mode = "ok"; await page.getByRole("button", { name: "Retry transcription", exact: true }).click();
  await until(async () => await input().inputValue() === "Keep on cancel. Meet at the café at ten.", "Retry did not reuse the retained recording.");

  mode = "slow"; before = audioCalls.length;
  await record(); await page.getByRole("button", { name: "Finish recording", exact: true }).click();
  await until(async () => audioCalls.length > before, "The delayed request did not arrive.");
  await page.screenshot({ path: `${output}/desktop-transcribing-light.png` });
  assert.notEqual(await page.evaluate("getComputedStyle(document.querySelector('.voice-processing')).maskImage"), "none");
  await input().fill("Edited while transcribing."); releaseTranscriptions();
  await until(async () => await input().inputValue() === "Edited while transcribing. Meet at the café at ten.", "Transcription overwrote edits made during the request.");
  before = audioCalls.length; await record(); await page.getByRole("button", { name: "Finish recording", exact: true }).click();
  await until(async () => audioCalls.length > before, "The cancelled request did not arrive.");
  await page.getByRole("button", { name: "Cancel voice input", exact: true }).click(); releaseTranscriptions();
  await page.waitForTimeout(150); assert.equal(await input().inputValue(), "Edited while transcribing. Meet at the café at ten.");
  mode = "empty"; await record(); await page.getByRole("button", { name: "Finish recording", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "No speech" }).waitFor(); await tracksStopped();
  await page.getByRole("button", { name: "Dismiss voice error", exact: true }).click(); mode = "ok";

  await page.evaluate(`window.__savedGetUserMedia = navigator.mediaDevices.getUserMedia; navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Denied', 'NotAllowedError'));`);
  await mic().click(); await page.getByRole("alert").filter({ hasText: "Microphone access was denied" }).waitFor();
  await page.getByRole("button", { name: "Dismiss voice error", exact: true }).click();
  await page.evaluate(`navigator.mediaDevices.getUserMedia = window.__savedGetUserMedia;`);
  await page.evaluate(`const original = navigator.mediaDevices.getUserMedia; navigator.mediaDevices.getUserMedia = (...args) => new Promise(resolve => { window.__releaseMicrophone = async () => { navigator.mediaDevices.getUserMedia = original; resolve(await original(...args)); }; });`);
  await mic().click(); await page.locator('.voice-status[data-state="requesting"]').waitFor();
  await page.getByRole("button", { name: "Cancel voice input", exact: true }).click();
  await page.evaluate("window.__releaseMicrophone()"); await tracksStopped();
  assert.equal(await page.locator(".voice-status").count(), 0, "A late permission grant must not restart recording.");
  await record(); await page.getByRole("button", { name: /^Settings for/ }).click(); await tracksStopped();
  await page.getByRole("button", { name: "Close", exact: true }).click(); assert.equal(await page.locator(".voice-status").count(), 0);
  await record(); await page.locator(".chat-head .pill").click(); await page.getByRole("button", { name: "Routines", exact: true }).click(); await tracksStopped();
  await page.getByRole("button", { name: "Chat", exact: true }).click(); await page.getByRole("button", { name: "Close bot details", exact: true }).click();
  await record(); await page.locator(`[data-bot-id="${otherBot}"]`).click(); await tracksStopped();
  assert.equal(await input().inputValue(), ""); await page.locator(`[data-bot-id="${botId}"]`).click();

  await page.setViewportSize({ width: 390, height: 844 }); await page.evaluate("document.documentElement.dataset.theme='dark'");
  await record(); await page.screenshot({ path: `${output}/phone-recording-dark.png` });
  assert.equal(await page.evaluate("document.documentElement.scrollWidth > innerWidth"), false);
  const phoneRecording = await page.locator('.composer-row').boundingBox();
  mode = "slow"; before = audioCalls.length;
  await page.getByRole("button", { name: "Finish recording", exact: true }).click();
  await until(async () => audioCalls.length > before, "Phone transcription did not arrive.");
  const phoneTranscribing = await page.locator('.composer-row').boundingBox();
  assert(phoneRecording && phoneTranscribing && Math.abs(phoneRecording.height - phoneTranscribing.height) < 1, "Recording and transcribing keep the composer height steady.");
  await page.screenshot({ path: `${output}/phone-transcribing-dark.png` });
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(await page.evaluate("getComputedStyle(document.querySelector('.voice-processing')).animationName"), "none");
  releaseTranscriptions();
  await page.getByText("Added to draft", { exact: true }).waitFor();
  await page.screenshot({ path: `${output}/phone-review-dark.png` });
  await page.setViewportSize({ width: 320, height: 700 });
  const toolbarFits = await page.locator('.composer-toolbar').evaluate((node) => node.scrollWidth <= node.clientWidth);
  assert(toolbarFits, "The review toolbar fits a narrow phone.");
  assert.equal(await page.evaluate("document.documentElement.scrollWidth > innerWidth"), false);
  await page.setViewportSize({ width: 390, height: 844 });
  mode = "busy"; await record(); await page.getByRole("button", { name: "Finish recording", exact: true }).click();
  await page.getByRole("button", { name: "Retry transcription", exact: true }).waitFor();
  await page.screenshot({ path: `${output}/phone-retry-dark.png` });
  await page.getByRole("button", { name: "Discard recording", exact: true }).click();
  mode = "ok"; await record();
  assert.equal(await page.evaluate("getComputedStyle(document.querySelector('.voice-waveform').lastElementChild).transitionDuration"), "0s");
  await page.getByRole("button", { name: "Cancel voice input", exact: true }).click(); await tracksStopped();

  await page.clock.install(); await record(); await page.clock.fastForward(121_000); await page.clock.resume();
  await until(async () => (await input().inputValue()).includes("Meet at the café at ten."), "The two-minute limit did not finish recording."); await tracksStopped();

  const audioSource = stripTypeScriptTypes(await readFile(new URL("../apps/web/src/voiceAudio.ts", import.meta.url), "utf8"));
  const conversion = await page.evaluate(`(async () => {
    const url = URL.createObjectURL(new Blob([${JSON.stringify(audioSource)}], { type: 'text/javascript' })); const audio = await import(url); URL.revokeObjectURL(url);
    const samples = new Float32Array(4800); for (let index = 0; index < samples.length; index++) samples[index] = Math.sin(index * 0.1) * 0.2;
    const converted = await audio.prepareRecording(new Blob([audio.encodeMonoWav(samples, 48000)], { type: 'audio/mp4' }));
    const wav = new DataView(await converted.arrayBuffer()); return { type: converted.type, rate: wav.getUint32(24, true), channels: wav.getUint16(22, true), bytes: converted.size };
  })()`);
  assert.deepEqual(conversion, { type: "audio/wav", rate: 16000, channels: 1, bytes: 3244 });

  assert.equal((await postAudio("invalid-bot-id")).status, 404);
  assert.equal((await postAudio(botId, Buffer.from("not audio"))).status, 422);
  assert.equal((await postAudio(botId, audioFixture, "text/plain")).status, 415);
  assert.equal((await postAudio(botId, Buffer.alloc(8 * 1024 * 1024 + 1))).status, 413);
  assert.equal((await fetch(`${base}/api/voice/${botId}`, { method: "POST", headers: { "Content-Type": "audio/webm", "X-Forwarded-For": "198.51.100.2" }, body: audioFixture })).status, 403);
  mode = "error"; const error = await postAudio(botId); const detail = await error.text(); assert.equal(error.status, 502); assert(!detail.includes("voice-check-key")); mode = "ok";
  const tailscale = voiceRoutes({ authMode: { kind: "tailscale" }, service: { query: (fn, ...args) => service.query(fn, ...args) }, masterKey: config.masterKey, mistralBaseUrl: config.mistral.baseUrl, model: config.transcriptionModel });
  assert.equal((await tailscale.request(`http://localhost/${botId}`, { method: "POST", headers: { "Content-Type": "audio/webm" }, body: audioFixture })).status, 401);
  assert.equal((await tailscale.request(`http://localhost/${botId}`, { method: "POST", headers: { "Content-Type": "audio/webm", "tailscale-user-login": "someone-else@example.com" }, body: audioFixture })).status, 404);
  const unsupported = await context.newPage(); await unsupported.addInitScript("window.MediaRecorder = undefined"); await unsupported.goto(`${base}/bots/${botId}`); await unsupported.locator("#message").waitFor();
  assert(await unsupported.getByRole("button", { name: "Start voice input", exact: true }).isDisabled()); await unsupported.close();
  assert.deepEqual(errors, []);
  console.log(`verify:voice passed (${useFirefox ? "Firefox" : "Chromium"}): quiet audio and silence, real browser recording and authenticated transcription, editable drafts, explicit sending, retry, cancel, empty speech, permission failures and late grants, track cleanup, navigation, mobile layout, duration limit, WAV conversion, request limits, ownership, and redacted provider errors. Audio devices and provider transcripts are fixtures.`);
  console.log(`Screenshots: ${output}`);
} catch (error) {
  await mkdir(output, { recursive: true }); await page.screenshot({ path: `${output}/failure.png` }).catch(() => {});
  console.error(logs.join("").slice(-2500)); throw error;
} finally {
  releaseTranscriptions(); await browser.close();
  for (const botId of bots) { await until(async () => await client.query(api.threads.activeRun, { botId }) === null, "A fixture chat did not stop."); if (await client.query(api.bots.get, { botId })) await client.mutation(api.bots.remove, { botId }); }
  if (child.exitCode === null) { child.kill("SIGTERM"); await new Promise<void>((resolve) => child.once("exit", () => resolve())); }
  fake.closeAllConnections(); await new Promise<void>((resolve) => fake.close(() => resolve()));
}
