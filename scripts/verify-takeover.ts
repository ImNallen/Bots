import assert from "node:assert/strict";
import { randomBytes, randomInt } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { api } from "@bots/convex";
import type { Id } from "@bots/convex/dataModel";
import { LINK_CLOSE } from "@bots/protocol";
import { ConvexHttpClient } from "convex/browser";
import { WebSocket } from "ws";

const CONVEX_PORT = 8443;
const RUN_TIMEOUT_MS = 180_000;
const OVERALL_TIMEOUT_MS = 480_000;
const WAIT_CHECK_MS = 15_000;
const TERMINAL = ["done", "failed", "cancelled"];

const [origin] = process.argv.slice(2);
if (origin === undefined || !URL.canParse(origin)) {
  console.error("usage: pnpm verify:takeover https://<machine>.<tailnet>.ts.net");
  process.exit(2);
}
setTimeout(() => {
  console.log(`FAIL  the check did not finish in ${OVERALL_TIMEOUT_MS / 1000} seconds`);
  process.exit(1);
}, OVERALL_TIMEOUT_MS).unref();

const wsOrigin = origin.replace(/^http/, "ws");
const response = await fetch(`${origin}/auth/token`);
assert.equal(response.status, 200);
const { token } = (await response.json()) as { token: string };
const client = new ConvexHttpClient(`https://${new URL(origin).hostname}:${CONVEX_PORT}`);
client.setAuth(token);
await client.mutation(api.users.ensureCurrent, {});

let failures = 0;
function report(ok: boolean, name: string, detail = ""): void {
  failures += ok ? 0 : 1;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail === "" ? "" : `: ${detail}`}`);
}

const nonce = randomBytes(4).toString("hex");
const SECRET = `hunter2-${randomBytes(6).toString("hex")}`;
const PUBLIC_TEXT = `typed-by-a-person-${nonce}`;
const PORT = randomInt(20_000, 40_000);

type Chat = { botId: Id<"bots">; threadId: Id<"threads"> };

async function newChat(name: string): Promise<Chat> {
  const botId = await client.mutation(api.bots.create, { name: `verify-takeover-${name}-${nonce}` });
  return { botId, threadId: await client.mutation(api.threads.ensureForBot, { botId }) };
}

async function runOf(chat: Chat, runId: Id<"runs">) {
  const { runs } = await client.query(api.threads.timeline, { threadId: chat.threadId });
  return runs.find((entry) => entry._id === runId);
}

async function settled(chat: Chat, runId: Id<"runs">) {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const run = await runOf(chat, runId);
    if (run !== undefined && TERMINAL.includes(run.state.kind)) {
      return run;
    }
    await sleep(500);
  }
  throw new Error(`run ${runId} did not end in ${RUN_TIMEOUT_MS / 1000} seconds`);
}

const resultsOf = (run: NonNullable<Awaited<ReturnType<typeof runOf>>>) =>
  run.events.flatMap(({ body }) => (body.kind === "toolResult" ? [body] : []));

function refusal(path: string, headers: Record<string, string>): Promise<number | "connected"> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`${wsOrigin}${path}`, { headers });
    socket.once("open", () => {
      socket.close();
      resolve("connected");
    });
    socket.once("unexpected-response", (_request, res) => resolve(res.statusCode ?? 0));
    socket.once("error", () => {});
  });
}

const form = `<!doctype html><title>Login</title><style>body{margin:0}input{position:fixed;left:0;width:100%;height:50%;font-size:40px}#u{top:0}#p{top:50%}</style><input id=u aria-label=Name><input id=p type=password aria-label=Secret>`;
const watched = await newChat("watched");
const other = await newChat("other");

const setup = await settled(
  watched,
  await client.mutation(api.threads.send, {
    threadId: watched.threadId,
    text: `Do exactly these two steps and then stop, with no other tool calls.\n1. Use the shell tool once with this command:\nprintf '%s' '${form}' > form.html && (nohup python3 -m http.server ${PORT} --bind 127.0.0.1 >/dev/null 2>&1 &) ; sleep 1; echo started\n2. Use browser_navigate once with this URL: http://127.0.0.1:${PORT}/form.html`,
  }),
);
const navigated = resultsOf(setup).find((result) => result.name === "browser_navigate");
report(navigated?.outcome === "ok" && /"Secret"/.test(navigated.output), "the bot opened a real form on its screen", navigated?.output.split("\n")[1]);

const inputPath = `/screens/${watched.botId}/input`;
const before = await refusal(inputPath, { Origin: origin });
report(before === 403, "input is refused until the owner takes over", String(before));

await client.mutation(api.bots.takeOver, { botId: watched.botId });
const crossSite = await refusal(inputPath, { Origin: "https://evil.example" });
report(crossSite === 403, "during a take-over, a page from another site still cannot send input", String(crossSite));

const input = new WebSocket(`${wsOrigin}${inputPath}`, { headers: { Origin: origin } });
await new Promise((resolve, reject) => {
  input.once("open", resolve);
  input.once("error", reject);
});
const inputClosed = new Promise<number>((resolve) => input.once("close", resolve));
const send = (event: object) => input.send(JSON.stringify(event));
const tapAt = (x: number, y: number) => {
  send({ kind: "pointer", x, y, action: "move" });
  send({ kind: "pointer", x, y, action: "down" });
  send({ kind: "pointer", x, y, action: "up" });
};

// The window's bars take about 85 pixels of the 800, and each field covers half of what is left.
tapAt(640, 260);
await sleep(400);
send({ kind: "text", text: PUBLIC_TEXT });
await sleep(400);
tapAt(640, 620);
await sleep(400);
send({ kind: "text", text: SECRET });
await sleep(800);

const gated = await client.mutation(api.threads.send, {
  threadId: watched.threadId,
  text: "Use browser_snapshot once and then stop, with no other tool calls.",
});
const otherRun = client.mutation(api.threads.send, {
  threadId: other.threadId,
  text: "Use browser_navigate once to open https://example.com/ and then stop, with no other tool calls.",
});
const otherResult = await settled(other, await otherRun);
const otherNavigated = resultsOf(otherResult).find((result) => result.name === "browser_navigate");
report(otherNavigated?.outcome === "ok", "another bot keeps working during the take-over", otherNavigated?.output.split("\n")[1]);

await sleep(WAIT_CHECK_MS);
const during = await runOf(watched, gated);
const asked = during?.events.some(({ body }) => body.kind === "assistantTurn" && body.toolCalls.length > 0) === true;
report(
  during !== undefined && !TERMINAL.includes(during.state.kind) && resultsOf(during).length === 0,
  "the bot waits before its next tool during the take-over",
  `state ${during?.state.kind}, model already asked for the tool: ${asked}, tool results ${during === undefined ? "?" : resultsOf(during).length}`,
);

await client.mutation(api.bots.releaseTakeover, { botId: watched.botId });
const closeCode = await Promise.race([inputClosed, sleep(15_000).then(() => "still open")]);
report(closeCode === LINK_CLOSE.takeoverEnded, "giving back closes the input channel", String(closeCode));

const finished = await settled(watched, gated);
const snapshot = resultsOf(finished).find((result) => result.name === "browser_snapshot");
report(finished.state.kind === "done" && snapshot?.outcome === "ok", "the bot carries on after the owner gives back", `run ${finished.state.kind}`);
report(snapshot?.output.includes(`value: ${PUBLIC_TEXT}`) === true, "what the person typed reached the right field on the real page", snapshot?.output.split("\n").find((line) => line.includes('"Name"')));
report(/"Secret" value: hidden/.test(snapshot?.output ?? ""), "the password reached its field, and the bot sees it only as hidden", snapshot?.output.split("\n").find((line) => line.includes('"Secret"')));

const { runs } = await client.query(api.threads.timeline, { threadId: watched.threadId });
report(!JSON.stringify(runs).includes(SECRET), "the password appears nowhere in the thread that reaches the model");

await client.mutation(api.threads.send, {
  threadId: watched.threadId,
  text: `Use the shell tool once with this command and then stop: pkill -f 'http.server ${PORT}' ; echo stopped`,
}).then((runId) => settled(watched, runId)).catch(() => {});

console.log(failures === 0 ? "verify:takeover passed" : `verify:takeover failed with ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
