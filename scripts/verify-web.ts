// Checks web_search and web_fetch against the real internet. The network checks run inside a computerd: in its Docker container,
// fed to node over stdin, or with --inside in this process from a computerd's release root, as on a VM. With an address, a real
// model then works through the deployed orchestrator, like verify:browser, and must reach for the text tools by itself.
//
//   pnpm verify:web [<container>] [https://<machine>.<tailnet>.ts.net]
//   node scripts/verify-web.ts --inside
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type { Id } from "@bots/convex/dataModel";
import type { ToolResult, WebInvocation } from "@bots/protocol";

const DEFAULT_CONTAINER = "bots-computer-computerd-1";
const CONVEX_PORT = 8443;
const RUN_TIMEOUT_MS = 240_000;
const TERMINAL = ["done", "failed", "cancelled"];

let failures = 0;
function report(ok: boolean, name: string, detail = ""): void {
  failures += ok ? 0 : 1;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail === "" ? "" : `: ${detail.slice(0, 300).replaceAll("\n", " | ")}`}`);
}

const SEARCHES: readonly [string, RegExp][] = [
  ["sqlite wal mode", /\bwal\b|write-ahead/i],
  ["solar eclipse 2027 path", /eclipse/i],
  ["rust tokio select macro", /tokio|select!/i],
];
const ARTICLE = "https://en.wikipedia.org/wiki/SQLite";
const REFUSED = ["http://127.0.0.1:9301/json/version", "http://10.78.0.2:8788/", "http://localtest.me:9301/json/version"];

async function networkChecks(): Promise<void> {
  const module = pathToFileURL(`${process.cwd()}/apps/computerd/src/web.ts`).href;
  const { createWeb, nodeNetwork } = (await import(module)) as typeof import("../apps/computerd/src/web.ts");
  const web = createWeb({ network: nodeNetwork });
  const run = (tool: WebInvocation): Promise<ToolResult> => web.execute({ tool, signal: new AbortController().signal });

  for (const [query, about] of SEARCHES) {
    const result = await run({ name: "web_search", args: { query } });
    const results = result.output.split("\n\n").slice(1);
    const relevant = results.filter((entry) => about.test(entry)).length;
    report(result.outcome === "ok" && results.length >= 5 && relevant >= 3, `web_search finds at least 5 results, most of them about "${query}"`, `${results.length} results, ${relevant} about it: ${result.output.split("\n")[2] ?? result.output}`);
  }

  const parts: ToolResult[] = [];
  let start: number | null = 0;
  while (start !== null && parts.length < 20) {
    const part = await run({ name: "web_fetch", args: { url: ARTICLE, start } });
    parts.push(part);
    const next = /start (\d+)\.$/.exec(part.output)?.[1];
    start = part.outcome === "ok" && next !== undefined ? Number(next) : null;
  }
  const first = parts[0]?.output ?? "";
  report(
    parts.length >= 2 && parts.every((part) => part.outcome === "ok") && first.startsWith("Title: SQLite - Wikipedia") && /\[\d+\]: https:\/\/en\.wikipedia\.org\//.test(first),
    "web_fetch reads a Wikipedia article in parts, with its links",
    `${parts.length} parts, ${parts.map((part) => Buffer.byteLength(part.output)).join(", ")} bytes`,
  );

  for (const url of REFUSED) {
    const result = await run({ name: "web_fetch", args: { url, start: 0 } });
    report(result.outcome === "error" && result.output.startsWith("Only public internet addresses can be opened"), `web_fetch refuses ${url} before it connects`, result.output);
  }

  const mismatch = await run({ name: "web_fetch", args: { url: "https://wrong.host.badssl.com/", start: 0 } });
  report(mismatch.outcome === "error" && mismatch.output.includes("does not match its name"), "a certificate for another name fails, so TLS checks the name and not the pinned address", mismatch.output);
  const example = await run({ name: "web_fetch", args: { url: "https://example.com/", start: 0 } });
  report(example.outcome === "ok" && example.output.includes("Example Domain"), "a page over TLS to a pinned address reads", example.output);
}

async function modelChecks(origin: string): Promise<void> {
  const { api } = await import("@bots/convex");
  const { ConvexHttpClient } = await import("convex/browser");
  const response = await fetch(`${origin}/auth/token`);
  if (response.status !== 200) {
    report(false, "GET /auth/token", String(response.status));
    return;
  }
  const { token } = (await response.json()) as { token: string };
  const client = new ConvexHttpClient(`https://${new URL(origin).hostname}:${CONVEX_PORT}`);
  client.setAuth(token);
  await client.mutation(api.users.ensureCurrent, {});
  const botIds: Id<"bots">[] = [];

  async function ask(name: string, text: string) {
    const botId: Id<"bots"> = await client.mutation(api.bots.create, { name: `verify-web-${name}-${randomBytes(3).toString("hex")}` });
    botIds.push(botId);
    const threadId = await client.mutation(api.threads.ensureForBot, { botId });
    const runId = await client.mutation(api.threads.send, { threadId, text });
    const deadline = Date.now() + RUN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const { runs } = await client.query(api.threads.timeline, { threadId });
      const run = runs.find((entry) => entry._id === runId);
      if (run !== undefined && TERMINAL.includes(run.state.kind)) {
        const bodies = run.events.map(({ body }) => body);
        return {
          state: run.state.kind,
          calls: bodies.flatMap((body) => (body.kind === "assistantTurn" ? body.toolCalls.map((call) => call.name) : [])),
          results: bodies.flatMap((body) => (body.kind === "toolResult" ? [body] : [])),
          reply: bodies.flatMap((body) => (body.kind === "assistantTurn" ? [body.text] : [])).join("\n"),
        };
      }
      await sleep(1000);
    }
    throw new Error(`the ${name} run did not end in ${RUN_TIMEOUT_MS / 1000} seconds`);
  }

  const onScreen = (calls: string[]) => calls.filter((call) => call.startsWith("browser_") || call.startsWith("desktop_"));
  const [page, sources] = await Promise.all([
    ask("page", "What does this page say? https://www.rfc-editor.org/rfc/rfc2606.html"),
    ask("sources", "Find two sources about the total solar eclipse of 2 August 2027, and give me their addresses."),
  ]);

  report(page.state === "done", "the page run finishes", page.state);
  report(page.results.some((result) => result.name === "web_fetch" && result.outcome === "ok"), "a bot asked what a page says reads it with web_fetch", page.calls.join(", "));
  report(onScreen(page.calls).length === 0, "and opens nothing on its screen", page.calls.join(", "));
  report(/reserved|example|\.test|\.invalid/i.test(page.reply), "its reply says what the page says", page.reply);

  report(sources.state === "done", "the sources run finishes", sources.state);
  report(sources.results.some((result) => result.name === "web_search" && result.outcome === "ok"), "a bot asked for sources searches with web_search", sources.calls.join(", "));
  report(onScreen(sources.calls).length === 0, "and opens nothing on its screen", sources.calls.join(", "));
  report(new Set(sources.reply.match(/https?:\/\/[^\s)\]>]+/g) ?? []).size >= 2, "its reply gives two addresses", sources.reply);

  // A failed run keeps its bots, because their threads show what went wrong.
  if (failures === 0) {
    await Promise.all(botIds.map((botId) => client.mutation(api.bots.remove, { botId })));
  }
}

const args = process.argv.slice(2);
if (args.includes("--inside")) {
  await networkChecks();
  process.exit(failures === 0 ? 0 : 1);
}

const origin = args.find((arg) => URL.canParse(arg));
const container = args.find((arg) => !URL.canParse(arg)) ?? DEFAULT_CONTAINER;
console.log(`network checks inside ${container}`);
const inside = spawnSync("docker", ["exec", "-i", "-w", "/app", container, "node", "--input-type=module-typescript", "-", "--inside"], {
  input: readFileSync(new URL(import.meta.url)),
  stdio: ["pipe", "inherit", "inherit"],
});
report(inside.status === 0, `the network checks pass inside ${container}`, inside.error?.message ?? `exit ${inside.status}`);
if (origin === undefined) {
  console.log("no address given, so no real model ran");
} else {
  await modelChecks(origin);
}
console.log(failures === 0 ? "verify:web passed" : `verify:web failed with ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
