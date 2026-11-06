import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { api } from "@bots/convex";
import { ConvexHttpClient } from "convex/browser";

const CONVEX_PORT = 8443;
const RUN_TIMEOUT_MS = 180_000;
const POLL_MS = 1000;
const TERMINAL = ["done", "failed", "cancelled"];

const [origin, vmName] = process.argv.slice(2);
if (origin === undefined || !URL.canParse(origin) || vmName === undefined) {
  console.error("usage: pnpm verify:template https://<machine>.<tailnet>.ts.net <VM name>");
  process.exit(2);
}

const response = await fetch(`${origin}/auth/token`);
assert.equal(response.status, 200, `GET /auth/token returned ${response.status}`);
const { token } = (await response.json()) as { token: string };
const client = new ConvexHttpClient(`https://${new URL(origin).hostname}:${CONVEX_PORT}`);
client.setAuth(token);

await client.mutation(api.users.ensureCurrent, {});
const { configured } = await client.query(api.credentials.status, {});
if (!configured) {
  console.error("This account has no Mistral key. Add one in the web app, then run this check again.");
  process.exit(2);
}

const nonce = randomBytes(6).toString("hex");
const botId = await client.mutation(api.bots.create, { name: `verify-template-${nonce}` });
await client.mutation(api.bots.setApprovalLevel, { botId, level: "nothing" });
const threadId = await client.mutation(api.threads.ensureForBot, { botId });
const runId = await client.mutation(api.threads.send, {
  threadId,
  text: `Use the shell tool once to run exactly this command, then repeat its output:\nprintf '%s %s %s\\n' "$(hostname)" "$(id -un)" ${nonce}`,
});

async function settledRun() {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { runs } = await client.query(api.threads.timeline, { threadId });
    const run = runs.find((entry) => entry._id === runId);
    if (run !== undefined && TERMINAL.includes(run.state.kind)) {
      return run;
    }
    await sleep(POLL_MS);
  }
  throw new Error(`run ${runId} did not end in ${RUN_TIMEOUT_MS / 1000} seconds`);
}

const run = await settledRun();
const results = run.events.flatMap(({ body }) => (body.kind === "toolResult" ? [body] : []));
const expected = `${vmName} agent ${nonce}`;
const proof = results.find((result) => result.name === "shell" && result.output.trim() === expected);

console.log(`run ended as ${run.state.kind}${run.state.kind === "failed" ? `: ${run.state.reason}` : ""}`);
for (const result of results) {
  console.log(`tool ${result.name}: ${result.outcome}, exit ${result.exitCode ?? "none"}: ${result.output.trim().slice(0, 200)}`);
}
if (run.state.kind !== "done" || proof === undefined || proof.outcome !== "ok") {
  console.log(`verify:template failed. A shell tool result must be exactly "${expected}" in a run that ends as done.`);
  process.exit(1);
}
await client.mutation(api.bots.remove, { botId });
console.log(`verify:template passed. A bot ran a tool on ${vmName} as agent, and it is deleted.`);
