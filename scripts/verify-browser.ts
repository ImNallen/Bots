import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { api } from "@bots/convex";
import type { Id } from "@bots/convex/dataModel";
import { ConvexHttpClient } from "convex/browser";

const CONVEX_PORT = 8443;
const RUN_TIMEOUT_MS = 240_000;
const TERMINAL = ["done", "failed", "cancelled"];

const [origin] = process.argv.slice(2);
if (origin === undefined || !URL.canParse(origin)) {
  console.error("usage: pnpm verify:browser https://<machine>.<tailnet>.ts.net");
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

async function ask(name: string, text: string) {
  const botId: Id<"bots"> = await client.mutation(api.bots.create, { name: `verify-browser-${name}-${randomBytes(3).toString("hex")}` });
  botIds.push(botId);
  const threadId = await client.mutation(api.threads.ensureForBot, { botId });
  const runId = await client.mutation(api.threads.send, { threadId, text });
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { runs } = await client.query(api.threads.timeline, { threadId });
    const run = runs.find((entry) => entry._id === runId);
    if (run !== undefined && TERMINAL.includes(run.state.kind)) {
      return run.events.flatMap(({ body }) => (body.kind === "toolResult" ? [body] : []));
    }
    await sleep(1000);
  }
  throw new Error(`the ${name} run did not end in ${RUN_TIMEOUT_MS / 1000} seconds`);
}

const INSTRUCTION = "Use browser_navigate once to open this URL, and then stop and say what the page is about. Do not use any other tool.";
const [first, second] = await Promise.all([
  ask("a", `${INSTRUCTION}\nhttps://example.com/`),
  ask("b", `${INSTRUCTION}\nhttps://www.iana.org/help/example-domains`),
]);

const firstResult = first.find((result) => result.name === "browser_navigate");
const secondResult = second.find((result) => result.name === "browser_navigate");
report(firstResult?.outcome === "ok" && /Example Domain/.test(firstResult.output), "bot A read its real page", firstResult?.output.slice(0, 90).replaceAll("\n", " | "));
report(secondResult?.outcome === "ok" && /iana\.org/.test(secondResult.output), "bot B read its real page", secondResult?.output.slice(0, 90).replaceAll("\n", " | "));

const screenOf = (output: string | undefined) => /^Screen (\d+)/.exec(output ?? "")?.[1];
const [screenA, screenB] = [screenOf(firstResult?.output), screenOf(secondResult?.output)];
report(screenA !== undefined && screenB !== undefined && screenA !== screenB, "two bots working at once have different screens", `${screenA} and ${screenB}`);

// A failed run keeps its bots, because their threads show what went wrong.
if (failures === 0) {
  await Promise.all(botIds.map((botId) => client.mutation(api.bots.remove, { botId })));
  const left = await Promise.all(botIds.map((botId) => client.query(api.bots.get, { botId })));
  report(left.every((bot) => bot === null), "deleting a bot that has finished removes it");
}

console.log(failures === 0 ? "verify:browser passed" : `verify:browser failed with ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
