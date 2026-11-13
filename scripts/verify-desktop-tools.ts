// A real model uses a real bot's desktop through the deployed orchestrator. Run it from a device on the tailnet, after a deploy of
// the desktop tools, on an owner whose computer runs a computerd with them.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { api } from "@bots/convex";
import type { Id } from "@bots/convex/dataModel";
import { ConvexHttpClient } from "convex/browser";

const CONVEX_PORT = 8443;
const RUN_TIMEOUT_MS = 300_000;
const TERMINAL = ["done", "failed", "cancelled"];

const [origin] = process.argv.slice(2);
if (origin === undefined || !URL.canParse(origin)) {
  console.error("usage: pnpm verify:desktop-tools https://<machine>.<tailnet>.ts.net");
  process.exit(2);
}

const response = await fetch(`${origin}/auth/token`);
assert.equal(response.status, 200, `GET /auth/token returned ${response.status}`);
const { token } = (await response.json()) as { token: string };
const client = new ConvexHttpClient(`https://${new URL(origin).hostname}:${CONVEX_PORT}`);
client.setAuth(token);
await client.mutation(api.users.ensureCurrent, {});

let failures = 0;
function report(ok: boolean, name: string, detail = ""): void {
  failures += ok ? 0 : 1;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail === "" ? "" : `: ${detail}`}`);
}

const botIds: Id<"bots">[] = [];

async function newBot(name: string, level: "outside" | "nothing") {
  const botId: Id<"bots"> = await client.mutation(api.bots.create, { name: `verify-desktop-${name}-${randomBytes(3).toString("hex")}` });
  botIds.push(botId);
  await client.mutation(api.bots.setApprovalLevel, { botId, level });
  const threadId = await client.mutation(api.threads.ensureForBot, { botId });
  return { botId, threadId };
}

async function settled(threadId: Id<"threads">, runId: Id<"runs">, onWait: () => Promise<void> = async () => {}) {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { runs } = await client.query(api.threads.timeline, { threadId });
    const run = runs.find((entry) => entry._id === runId);
    if (run !== undefined && TERMINAL.includes(run.state.kind)) {
      return run;
    }
    await onWait();
    await sleep(1000);
  }
  throw new Error(`run ${runId} did not end in ${RUN_TIMEOUT_MS / 1000} seconds`);
}

const MENU_TASK =
  "Use desktop_look to see your screen. Then use desktop_click on the mark of Chromium's own menu button, the one named Chromium at the top right of the browser window. Look at the menu that opens, and tell me its first three items, in order. Then press Escape with desktop_key to close the menu. Use no other tools.";

const reader = await newBot("menu", "nothing");
const readerRun = await settled(reader.threadId, await client.mutation(api.threads.send, { threadId: reader.threadId, text: MENU_TASK }));
const calls = readerRun.events.flatMap(({ body }) => (body.kind === "assistantTurn" ? body.toolCalls.map((call) => call.name) : []));
const results = readerRun.events.flatMap(({ body }) => (body.kind === "toolResult" ? [body] : []));
const reply = readerRun.events.flatMap(({ body }) => (body.kind === "assistantTurn" ? [body.text] : [])).join("\n");
report(readerRun.state.kind === "done", "the run finishes", readerRun.state.kind);
report(calls.includes("desktop_look") && calls.includes("desktop_click"), "the bot looked at its screen and clicked a mark", calls.join(", "));
report(results.some((result) => result.name === "desktop_click" && result.outcome === "ok" && /Chromium/.test(result.output)), "a click's result names what it clicked", results.map((result) => `${result.name}: ${result.output.split("\n")[0]}`).join(" | "));
report(/new tab/i.test(reply) && /new window/i.test(reply), "the reply names the menu's first items, which only the desktop can show", reply.slice(0, 200));
report(!results.some((result) => result.output.includes("data:image")), "no picture reaches the stored history");
const usage = readerRun.events.flatMap(({ body }) => (body.kind === "assistantTurn" ? [body.usage] : []));
console.log(
  `tokens  ${usage.length} model calls, prompt/cached per call: ${usage.map((u) => `${u.promptTokens}/${u.cachedTokens ?? "?"}`).join(" ")}, completion ${usage.reduce((sum, u) => sum + u.completionTokens, 0)}`,
);

const asker = await newBot("card", "outside");
const askerRunId = await client.mutation(api.threads.send, { threadId: asker.threadId, text: MENU_TASK });
let card: { subject: string | null; picture: boolean } | null = null;
let cards = 0;
const askerRun = await settled(asker.threadId, askerRunId, async () => {
  for (const pending of await client.query(api.approvals.pendingForThread, { threadId: asker.threadId })) {
    if (card === null) {
      const target = await client.query(api.screens.forApproval, { approvalId: pending._id });
      card = { subject: pending.subject, picture: target !== null && target.image.bytes.byteLength > 0 };
    }
    cards += 1;
    await client.mutation(api.approvals.decide, { approvalId: pending._id, decision: "denied" });
  }
});
const shown = card as { subject: string | null; picture: boolean } | null;
report(shown?.subject?.startsWith("Click ") === true && shown.subject.includes("Chromium"), "the default level asks before a click, and the card says what it clicks", shown?.subject ?? "no card");
report(shown?.picture === true, "the card has the screen to show, with the target outlined");
report(
  askerRun.events.some(({ body }) => body.kind === "toolResult" && body.name === "desktop_click" && body.outcome === "denied"),
  "a denied click is recorded as denied, and nothing was clicked",
);
report(cards === 1, "the bot does not ask again for a click the owner denied", `${cards} card(s)`);

// A failed run keeps its bots, because their threads show what went wrong.
if (failures === 0) {
  await Promise.all(botIds.map((botId) => client.mutation(api.bots.remove, { botId })));
}

console.log(failures === 0 ? "verify:desktop-tools passed" : `verify:desktop-tools failed with ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
