import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { api } from "@bots/convex";
import type { Id } from "@bots/convex/dataModel";
import {
  OUTPUT_CAP_BYTES,
  callIdToFileStem,
  computerMessage,
  parseJsonMessage,
  type OrchestratorMessage,
  type ToolResult,
} from "@bots/protocol";
import { ConvexHttpClient } from "convex/browser";
import type { FunctionReturnType } from "convex/server";
import { SignJWT, importJWK } from "jose";
import { WebSocket, WebSocketServer } from "ws";
import { decryptApiKey, hashComputerToken } from "../apps/orchestrator/src/secrets.ts";
import { paths, parsePrivateJwk, readEnvFile, runCommand, runConvex } from "./lib.ts";

const WATCHDOG_MS = 15 * 60 * 1000;
const LOOPBACK = "127.0.0.1";
const AUDIENCE = "bots";
const SERVICE_SUBJECT = "service:orchestrator";
const COMPUTER_PROJECT = "bots-verify-agent";
const DIRECT_PROJECT = "bots-verify-agent-direct";
const LEASE_MS = 15_000;
const COMPUTER_WAIT_SECONDS = 20;
const JOURNAL_DIR = "/var/lib/computerd/journal";
const TERMINAL = ["done", "failed", "cancelled"];

const nonce = randomBytes(4).toString("hex");
const TEST_LOGIN = `verify-agent-${nonce}@localhost`;
const SECOND_SUBJECT = `dev:verify-agent-second-${nonce}@localhost`;
const MISTRAL_KEY = `verify-secret-key-${randomBytes(12).toString("hex")}`;
const REJECTED_KEY = `rejected-key-${randomBytes(12).toString("hex")}`;
const COMPUTER_TOKEN = randomBytes(32).toString("base64url");
const SECOND_COMPUTER_TOKEN = randomBytes(32).toString("base64url");

let failures = 0;

async function check(name: string, body: () => void | Promise<void>): Promise<void> {
  try {
    await body();
    console.log(`ok    ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function scenario(title: string, body: () => Promise<void>): Promise<void> {
  console.log(`--- ${title}`);
  try {
    await body();
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${title} stopped early: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function waitFor<T>(args: {
  description: string;
  timeoutMs?: number;
  intervalMs?: number;
  probe: () => T | null | undefined | Promise<T | null | undefined>;
}): Promise<T> {
  const deadline = Date.now() + (args.timeoutMs ?? 60_000);
  for (;;) {
    const value = await args.probe();
    if (value !== null && value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${args.description}`);
    }
    await sleep(args.intervalMs ?? 100);
  }
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.on("error", reject);
    server.listen(0, LOOPBACK, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("could not read the free port"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

type FakeMessage = { role: string; content?: unknown; tool_calls?: { id: string }[]; tool_call_id?: string };
type FakeRequest = {
  at: number;
  authorization: string;
  body: { messages: FakeMessage[]; tools: { function: { name: string } }[]; parallel_tool_calls: boolean; stream: boolean };
};

type FakeToolCall = { id?: string; name: string; arguments: string };

type Reply =
  | { kind: "text"; text: string; reasoning?: string; chunkDelayMs?: number }
  | { kind: "tools"; calls: FakeToolCall[]; delivery: "pieces" | "whole" }
  | { kind: "stall"; partial: string }
  | { kind: "status"; status: number; retryAfter?: string };

type Script = (context: { attempt: number; toolResults: FakeMessage[] }) => Reply;

function latestUserText(messages: FakeMessage[]): string {
  const last = messages.findLast((message) => message.role === "user");
  return typeof last?.content === "string" ? last.content : "";
}

function toolMessagesAfterLatestUser(messages: FakeMessage[]): FakeMessage[] {
  const userIndex = messages.findLastIndex((message) => message.role === "user");
  return messages.slice(userIndex + 1).filter((message) => message.role === "tool");
}

async function writeSse(response: ServerResponse, payload: unknown): Promise<void> {
  const frame = `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`;
  const middle = Math.floor(frame.length / 2);
  response.write(frame.slice(0, middle));
  await sleep(1);
  response.write(frame.slice(middle));
}

function chunk(delta: unknown, finishReason: string | null = null): unknown {
  return {
    id: "fake",
    object: "chat.completion.chunk",
    model: "fake-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

async function finishSse(response: ServerResponse, finishReason: string): Promise<void> {
  await writeSse(response, {
    ...(chunk({ content: "" }, finishReason) as object),
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  });
  await writeSse(response, "[DONE]");
  response.end();
}

async function streamReply(response: ServerResponse, reply: Reply): Promise<void> {
  if (reply.kind === "status") {
    const headers = reply.retryAfter === undefined ? {} : { "Retry-After": reply.retryAfter };
    response.writeHead(reply.status, { ...headers, "Content-Type": "application/json" });
    response.end(JSON.stringify({ message: `scripted ${reply.status}` }));
    return;
  }
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  switch (reply.kind) {
    case "text": {
      if (reply.reasoning !== undefined) {
        await writeSse(
          response,
          chunk({ content: [{ type: "thinking", thinking: [{ type: "text", text: reply.reasoning }] }] }),
        );
      }
      const pieces = reply.text.match(/.{1,8}/gs) ?? [];
      for (const piece of pieces) {
        await writeSse(response, chunk({ role: "assistant", content: piece }));
        await sleep(reply.chunkDelayMs ?? 0);
      }
      await finishSse(response, "stop");
      return;
    }
    case "tools": {
      for (const [index, call] of reply.calls.entries()) {
        const id = call.id ?? `f${randomBytes(4).toString("hex")}`;
        if (reply.delivery === "whole") {
          await writeSse(
            response,
            chunk({ tool_calls: [{ id, index, function: { name: call.name, arguments: call.arguments } }] }),
          );
          continue;
        }
        await writeSse(response, chunk({ tool_calls: [{ id, index, function: { name: call.name, arguments: "" } }] }));
        const middle = Math.floor(call.arguments.length / 2);
        for (const piece of [call.arguments.slice(0, middle), call.arguments.slice(middle)]) {
          await writeSse(response, chunk({ tool_calls: [{ id: "null", index, function: { arguments: piece } }] }));
        }
      }
      await finishSse(response, "tool_calls");
      return;
    }
    case "stall":
      await writeSse(response, chunk({ role: "assistant", content: reply.partial }));
      return;
  }
}

function startFakeMistral() {
  const scripts = new Map<string, Script>();
  const requests = new Map<string, FakeRequest[]>();
  const server = createServer((incoming, response) => {
    const authorization = incoming.headers.authorization ?? "";
    if (incoming.method === "GET" && incoming.url === "/v1/models") {
      const rejected = authorization.includes("rejected-key");
      response.writeHead(rejected ? 401 : 200, { "Content-Type": "application/json" });
      response.end(rejected ? '{"message":"Unauthorized"}' : '{"data":[]}');
      return;
    }
    const parts: Buffer[] = [];
    incoming.on("data", (part: Buffer) => parts.push(part));
    incoming.on("end", () => {
      const body = JSON.parse(Buffer.concat(parts).toString("utf8")) as FakeRequest["body"];
      const text = latestUserText(body.messages);
      const seen = requests.get(text) ?? [];
      seen.push({ at: Date.now(), authorization, body });
      requests.set(text, seen);
      const script = scripts.get(text);
      const reply: Reply =
        script === undefined
          ? { kind: "status", status: 400 }
          : script({ attempt: seen.length, toolResults: toolMessagesAfterLatestUser(body.messages) });
      streamReply(response, reply).catch(() => response.destroy());
    });
  });
  return {
    script: (text: string, reply: Script) => scripts.set(text, reply),
    requests: (text: string) => requests.get(text) ?? [],
    listen: () =>
      new Promise<number>((resolve) => {
        server.listen(0, LOOPBACK, () => {
          const address = server.address();
          resolve(typeof address === "object" && address !== null ? address.port : 0);
        });
      }),
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

function shellCall(command: string, timeoutSeconds?: number): FakeToolCall {
  return { name: "shell", arguments: JSON.stringify({ command, timeoutSeconds }) };
}

const rootEnv = readEnvFile(paths.rootEnv);
const convexUrl = readEnvFile(paths.convexEnv).CONVEX_SELF_HOSTED_URL;
const { JWT_PRIVATE_JWK, JWT_ISSUER, MASTER_KEY } = rootEnv;
if (JWT_PRIVATE_JWK === undefined || JWT_ISSUER === undefined || MASTER_KEY === undefined || convexUrl === undefined) {
  console.error("FAIL  .env.local is incomplete. Run pnpm bootstrap first.");
  process.exit(1);
}
const privateJwk = parsePrivateJwk(JWT_PRIVATE_JWK);
const signingKey = await importJWK(privateJwk, "ES256");
const issuer: string = JWT_ISSUER;
const masterKey = Buffer.from(MASTER_KEY, "base64");

async function signToken(subject: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({ email: `${subject}@verify`, name: subject })
    .setProtectedHeader({ alg: "ES256", kid: privateJwk.kid, typ: "JWT" })
    .setSubject(subject)
    .setIssuer(issuer)
    .setAudience(AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(signingKey);
}

function clientFor(token: string): ConvexHttpClient {
  const client = new ConvexHttpClient(convexUrl as string);
  client.setAuth(token);
  return client;
}

function docker(argv: string[], env?: Record<string, string>): string {
  const result = runCommand({ command: "docker", argv, cwd: paths.repoRoot, env });
  if (result.kind === "failed") {
    throw new Error(`docker ${argv.slice(0, 3).join(" ")} failed: ${result.output}`);
  }
  return result.stdout;
}

function computerCompose(args: { project: string; argv: string[]; env?: Record<string, string> }): string {
  return docker(
    ["compose", "--project-name", args.project, "--file", `${paths.computerdComposeDir}/compose.yaml`, ...args.argv],
    { COMPUTER_TOKEN, ...args.env },
  );
}

function startComputer(args: { project: string; linkPort: number }): string {
  computerCompose({ project: args.project, argv: ["down", "--volumes", "--timeout", "1"] });
  const env = { COMPUTER_LINK_URL: `ws://host.docker.internal:${args.linkPort}` };
  computerCompose({ project: args.project, argv: ["up", "--detach", "--build", "--wait"], env });
  return computerCompose({ project: args.project, argv: ["ps", "--quiet", "computerd"] }).trim();
}

function stopComputer(project: string): void {
  computerCompose({ project, argv: ["down", "--volumes", "--timeout", "1"] });
}

function shellIn(container: string, command: string): string {
  return docker(["exec", container, "bash", "-c", command]);
}

// No shell, because a shell's own command line would match the pattern.
function agentProcessRunning(args: { container: string; pattern: string }): boolean {
  const result = runCommand({
    command: "docker",
    argv: ["exec", args.container, "pgrep", "-u", "agent", "-f", args.pattern],
    cwd: paths.repoRoot,
  });
  return result.kind === "ok" && result.stdout.trim() !== "";
}

function shellResult(container: string, command: string): { ok: boolean; output: string } {
  const result = runCommand({
    command: "docker",
    argv: ["exec", container, "bash", "-c", command],
    cwd: paths.repoRoot,
  });
  return result.kind === "ok" ? { ok: true, output: result.stdout } : { ok: false, output: result.output };
}

const orchestratorPort = await findFreePort();
const linkPort = await findFreePort();
const fake = startFakeMistral();
const fakePort = await fake.listen();
const orchestratorLogs: Buffer[] = [];
let orchestrator: ChildProcess | null = null;

async function startOrchestrator(): Promise<void> {
  const child = spawn(process.execPath, [paths.orchestratorMain], {
    env: {
      ...process.env,
      ...rootEnv,
      AUTH_MODE: "dev",
      DEV_LOGIN: TEST_LOGIN,
      PORT: String(orchestratorPort),
      LINK_HOST: LOOPBACK,
      LINK_PORT: String(linkPort),
      COMPUTER_TOKEN,
      COMPUTER_WAIT_SECONDS: String(COMPUTER_WAIT_SECONDS),
      MISTRAL_BASE_URL: `http://${LOOPBACK}:${fakePort}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (part: Buffer) => orchestratorLogs.push(part));
  child.stderr?.on("data", (part: Buffer) => orchestratorLogs.push(part));
  orchestrator = child;
  await waitFor({
    description: "the orchestrator to become healthy",
    timeoutMs: 20_000,
    probe: () =>
      fetch(`http://${LOOPBACK}:${orchestratorPort}/healthz`).then(
        (response) => (response.ok ? true : null),
        () => null,
      ),
  });
}

async function killOrchestrator(): Promise<void> {
  const child = orchestrator;
  if (child === null || child.exitCode !== null) {
    return;
  }
  const exited = new Promise((done) => child.once("exit", done));
  child.kill("SIGKILL");
  await exited;
  orchestrator = null;
}

function logsText(): string {
  return Buffer.concat(orchestratorLogs).toString("utf8");
}

const mainContainer = { id: "" };

function workspaceFile(chat: Chat, name: string): string {
  return `/workspace/${chat.botId}/${name}`;
}

function linesOf(args: { container: string; path: string }): string[] {
  const { ok, output } = shellResult(args.container, `cat ${args.path} 2>/dev/null`);
  return ok ? output.split("\n").filter((line) => line !== "") : [];
}

type Timeline = FunctionReturnType<typeof api.threads.timeline>;
type TimelineRun = Timeline["runs"][number];
type Body = TimelineRun["events"][number]["body"];

type Chat = {
  client: ConvexHttpClient;
  botId: Id<"bots">;
  threadId: Id<"threads">;
  send: (text: string) => Promise<Id<"runs">>;
  run: (runId: Id<"runs">) => Promise<TimelineRun | undefined>;
  settled: (runId: Id<"runs">, timeoutMs?: number) => Promise<TimelineRun>;
};

async function newChat(args: { client: ConvexHttpClient; name: string }): Promise<Chat> {
  const { client } = args;
  await client.mutation(api.users.ensureCurrent, {});
  const botId = await client.mutation(api.bots.create, { name: `${args.name}-${nonce}` });
  const threadId = await client.mutation(api.threads.ensureForBot, { botId });
  async function run(runId: Id<"runs">) {
    const timeline = await client.query(api.threads.timeline, { threadId });
    return timeline.runs.find((entry) => entry._id === runId);
  }
  return {
    client,
    botId,
    threadId,
    send: (text) => client.mutation(api.threads.send, { threadId, text }),
    run,
    settled: (runId, timeoutMs) =>
      waitFor({
        description: `run ${runId} to end`,
        timeoutMs: timeoutMs ?? 90_000,
        intervalMs: 200,
        probe: async () => {
          const entry = await run(runId);
          return entry !== undefined && TERMINAL.includes(entry.state.kind) ? entry : null;
        },
      }),
  };
}

function bodiesOf(run: TimelineRun): Body[] {
  return run.events.map((event) => event.body);
}

function turnsOf(run: TimelineRun) {
  return bodiesOf(run).filter((body) => body.kind === "assistantTurn");
}

function resultsOf(run: TimelineRun) {
  return bodiesOf(run).filter((body) => body.kind === "toolResult");
}

function streamRows(runId: string): unknown[] {
  const result = runConvex(["data", "runStreams", "--limit", "1000", "--format", "jsonLines"]);
  assert.ok(result.kind === "ok", "convex data runStreams failed");
  return result.stdout
    .split("\n")
    .filter((line) => line.includes(runId))
    .map((line) => JSON.parse(line) as unknown);
}

function toolMessagesText(request: FakeRequest | undefined): string {
  const tools = request === undefined ? [] : toolMessagesAfterLatestUser(request.body.messages);
  return tools.map((message) => String(message.content)).join("\n");
}

function keyRequest(args: { method: string; body?: string; headers?: Record<string, string> }) {
  return fetch(`http://${LOOPBACK}:${orchestratorPort}/api/mistral-key`, {
    method: args.method,
    headers: args.headers ?? { "Content-Type": "application/json" },
    body: args.body,
  });
}

const putKey = (key: string) => keyRequest({ method: "PUT", body: JSON.stringify({ key }) });

async function assertRejected(promise: Promise<unknown>, expected: RegExp): Promise<void> {
  await assert.rejects(promise, expected);
}

type LinkProbe = {
  socket: WebSocket;
  opened: Promise<void>;
  closed: Promise<number>;
  messages: OrchestratorMessage[];
};

function openLink(port: number): LinkProbe {
  const socket = new WebSocket(`ws://${LOOPBACK}:${port}`);
  const messages: OrchestratorMessage[] = [];
  socket.on("message", (raw: Buffer) => messages.push(JSON.parse(raw.toString("utf8")) as OrchestratorMessage));
  socket.on("error", () => {});
  return {
    socket,
    messages,
    opened: new Promise((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    }),
    closed: new Promise((resolve) => socket.once("close", (code) => resolve(code))),
  };
}

async function helloLink(token: string): Promise<LinkProbe> {
  const probe = openLink(linkPort);
  await probe.opened;
  probe.socket.send(JSON.stringify({ kind: "hello", token }));
  await waitFor({
    description: "the welcome message",
    timeoutMs: 5000,
    probe: () => (probe.messages.some((message) => message.kind === "welcome") ? true : null),
  });
  return probe;
}

function startDirectLink(port: number) {
  const server = new WebSocketServer({ host: LOOPBACK, port });
  const connection: { socket: WebSocket | null; closes: number[]; helloToken: string | null } = {
    socket: null,
    closes: [],
    helloToken: null,
  };
  const waiters = new Map<string, ((result: ToolResult) => void)[]>();
  server.on("connection", (socket) => {
    socket.on("message", (raw: Buffer) => {
      const message = parseJsonMessage({ raw: raw.toString("utf8"), schema: computerMessage });
      if (message === null) {
        throw new Error("computerd sent a message that does not parse");
      }
      if (message.kind === "hello") {
        connection.helloToken = message.token;
        connection.socket = socket;
        socket.send(JSON.stringify({ kind: "welcome" } satisfies OrchestratorMessage));
        return;
      }
      const waiting = waiters.get(message.callId) ?? [];
      waiters.delete(message.callId);
      waiting.forEach((resolve) => resolve(message.result));
    });
    socket.on("close", (code) => {
      connection.closes.push(code);
      if (connection.socket === socket) {
        connection.socket = null;
      }
    });
  });
  const ready = () =>
    waitFor({
      description: "computerd to connect to the direct link",
      timeoutMs: 30_000,
      probe: () => connection.socket,
    });
  return {
    connection,
    ready,
    close: () => {
      for (const client of server.clients) {
        client.terminate();
      }
      server.close();
    },
    // docker calls here block the event loop, so a close can still be queued. Like the runner, this asks again.
    async ask(message: Exclude<OrchestratorMessage, { kind: "welcome" }>): Promise<ToolResult> {
      const deadline = Date.now() + 30_000;
      const { promise, resolve } = Promise.withResolvers<ToolResult>();
      waiters.set(message.callId, [...(waiters.get(message.callId) ?? []), resolve]);
      let answered = false;
      promise.then(() => {
        answered = true;
      });
      while (!answered) {
        if (Date.now() > deadline) {
          throw new Error(`no answer to ${message.kind} ${message.callId}`);
        }
        const socket = await ready();
        socket.send(JSON.stringify(message));
        while (!answered && socket.readyState === WebSocket.OPEN && Date.now() < deadline) {
          await sleep(50);
        }
      }
      return await promise;
    },
    sendRaw: async (raw: string) => (await ready()).send(raw),
  };
}

setTimeout(() => {
  console.error(`FAIL  verify:agent did not finish within ${WATCHDOG_MS} ms`);
  process.exit(1);
}, WATCHDOG_MS).unref();

const firstToken = await signToken(`dev:${TEST_LOGIN}`);
const first = clientFor(firstToken);
const second = clientFor(await signToken(SECOND_SUBJECT));
const service = clientFor(await signToken(SERVICE_SUBJECT));
const anonymous = new ConvexHttpClient(convexUrl);
let happyRunId: Id<"runs"> | null = null;
let happyChat: Chat | null = null;

mainContainer.id = startComputer({ project: COMPUTER_PROJECT, linkPort });
console.log(`info  chose project ${COMPUTER_PROJECT}, container ${mainContainer.id.slice(0, 12)}, login ${TEST_LOGIN}`);

try {
  await startOrchestrator();
  const ownerRow = await first.mutation(api.users.ensureCurrent, {});
  const ownerId = ownerRow._id;

  await scenario("J. a missing key fails the run", async () => {
    const chat = await newChat({ client: first, name: "missing-key" });
    const text = `no key ${nonce}`;
    fake.script(text, () => ({ kind: "text", text: "unreachable" }));
    const run = await chat.settled(await chat.send(text));
    await check("the run fails with a reason telling the user to add a key", () => {
      assert.equal(run.state.kind, "failed");
      assert.match(run.state.kind === "failed" ? run.state.reason : "", /No Mistral API key is set\. Add one/);
    });
    await check("the model was never called", () => assert.equal(fake.requests(text).length, 0));
  });

  await scenario("A. key handling", async () => {
    await check("credentials.status starts unconfigured", async () => {
      assert.deepEqual(await first.query(api.credentials.status, {}), { configured: false, last4: null });
    });
    await check("PUT with a key Mistral refuses returns the error and stores nothing", async () => {
      const response = await putKey(REJECTED_KEY);
      assert.equal(response.status, 400);
      assert.match(JSON.stringify(await response.json()), /Mistral rejected this key/);
      assert.equal(await service.query(api.credentials.ciphertextFor, { ownerId }), null);
    });
    await check("PUT without Content-Type application/json returns 415 and stores nothing", async () => {
      const response = await keyRequest({
        method: "PUT",
        body: JSON.stringify({ key: MISTRAL_KEY }),
        headers: { "Content-Type": "text/plain" },
      });
      assert.equal(response.status, 415);
      assert.equal(await service.query(api.credentials.ciphertextFor, { ownerId }), null);
    });
    await check("PUT with a malformed body returns 400", async () => {
      const response = await keyRequest({ method: "PUT", body: '{"key":1}' });
      assert.equal(response.status, 400);
    });
    await check("PUT with a forwarding header is refused by the dev guard", async () => {
      const response = await keyRequest({
        method: "PUT",
        body: JSON.stringify({ key: MISTRAL_KEY }),
        headers: { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.9" },
      });
      assert.equal(response.status, 403);
    });
    const stored = await putKey(MISTRAL_KEY);
    await check("PUT stores an accepted key and answers with no CORS headers", async () => {
      assert.equal(stored.status, 200);
      assert.equal(stored.headers.get("access-control-allow-origin"), null);
      assert.deepEqual(await stored.json(), { configured: true, last4: MISTRAL_KEY.slice(-4) });
    });
    const row = await service.query(api.credentials.ciphertextFor, { ownerId });
    await check("the Convex row holds neither the plaintext nor a plain encoding of it", () => {
      assert.ok(row !== null);
      const raw = JSON.stringify(row);
      assert.ok(!raw.includes(MISTRAL_KEY));
      assert.ok(!raw.includes(Buffer.from(MISTRAL_KEY).toString("base64")));
      assert.equal(row.last4, MISTRAL_KEY.slice(-4));
      assert.equal(row.keyVersion, 1);
    });
    await check("the row decrypts with the owner's id and fails with another owner's id", () => {
      assert.ok(row !== null);
      assert.equal(decryptApiKey({ masterKey, ownerId, encrypted: row }), MISTRAL_KEY);
      assert.throws(() => decryptApiKey({ masterKey, ownerId: `${ownerId}x`, encrypted: row }));
    });
    await check("credentials.status returns only configured and last4", async () => {
      assert.deepEqual(await first.query(api.credentials.status, {}), {
        configured: true,
        last4: MISTRAL_KEY.slice(-4),
      });
    });
    await check("a user token cannot call credentials.ciphertextFor", async () => {
      await assertRejected(first.query(api.credentials.ciphertextFor, { ownerId }), /Not authorized/);
    });
    await check("DELETE removes the key", async () => {
      assert.equal((await keyRequest({ method: "DELETE" })).status, 200);
      assert.equal(await service.query(api.credentials.ciphertextFor, { ownerId }), null);
      assert.deepEqual(await first.query(api.credentials.status, {}), { configured: false, last4: null });
    });
    await check("PUT stores the key again", async () => {
      assert.equal((await putKey(MISTRAL_KEY)).status, 200);
    });
  });

  await scenario("B. happy path", async () => {
    const chat = await newChat({ client: first, name: "happy" });
    happyChat = chat;
    await check("threads.ensureForBot returns the same thread on a second call", async () => {
      assert.equal(await first.mutation(api.threads.ensureForBot, { botId: chat.botId }), chat.threadId);
    });
    const text = `happy ${nonce}`;
    const answer = "This reply streams in many small chunks so that a poll can catch it midway through.";
    fake.script(text, ({ toolResults }) =>
      toolResults.length === 0
        ? { kind: "tools", delivery: "pieces", calls: [shellCall(`echo hello-${nonce}; id -un; pwd`)] }
        : { kind: "text", text: answer, reasoning: `thinking-${nonce}`, chunkDelayMs: 60 },
    );
    const runId = await chat.send(text);
    happyRunId = runId;
    const streamed = await waitFor({
      description: "a partial stream row",
      probe: async () => {
        const entry = await chat.run(runId);
        const partial = entry?.stream?.text ?? "";
        return partial.length > 0 && partial.length < answer.length ? entry?.stream : null;
      },
      intervalMs: 50,
    });
    await check("the timeline shows the in-progress turn while it streams", () => {
      assert.ok(answer.startsWith(streamed?.text ?? "nope"));
      assert.equal(streamed?.reasoning, `thinking-${nonce}`);
    });
    const run = await chat.settled(runId);
    const requests = fake.requests(text);
    await check("the run is done", () => assert.equal(run.state.kind, "done"));
    await check("seq runs from 0 with no gaps", () => {
      assert.deepEqual(
        run.events.map((event) => event.seq),
        run.events.map((_, index) => index),
      );
      assert.equal(run.events.length, 4);
    });
    await check("the events are user, assistant, tool result, assistant", () => {
      assert.deepEqual(
        bodiesOf(run).map((body) => body.kind),
        ["userMessage", "assistantTurn", "toolResult", "assistantTurn"],
      );
    });
    await check("the shell ran as agent in the bot's workspace", () => {
      const [result] = resultsOf(run);
      assert.equal(result?.outcome, "ok");
      assert.equal(result?.exitCode, 0);
      assert.equal(result?.output, `hello-${nonce}\nagent\n/workspace/${chat.botId}\n`);
    });
    await check("the final turn keeps text, reasoning, usage, and model", () => {
      const last = turnsOf(run).at(-1);
      assert.equal(last?.text, answer);
      assert.equal(last?.reasoning, `thinking-${nonce}`);
      assert.deepEqual(last?.usage, { promptTokens: 11, completionTokens: 7 });
      assert.equal(last?.model, "fake-model");
    });
    await check("no stream row is left", () => assert.deepEqual(streamRows(runId), []));
    await check("the tool result reaches the model with its outcome", () => {
      assert.equal(requests.length, 2);
      const content = toolMessagesText(requests[1]);
      assert.match(content, /^outcome: ok\nexit code: 0\n/);
      assert.match(content, new RegExp(`hello-${nonce}`));
    });
    await check("the request disables parallel tool calls, streams, and lists the three tools", () => {
      const body = requests[0]?.body;
      assert.equal(body?.parallel_tool_calls, false);
      assert.equal(body?.stream, true);
      assert.deepEqual(body?.tools.map((tool) => tool.function.name), ["shell", "read_file", "write_file"]);
    });
    await check("the model call carries the decrypted key", () => {
      assert.equal(requests[0]?.authorization, `Bearer ${MISTRAL_KEY}`);
    });
    await check("the system prompt names the bot and calls tool output untrusted", () => {
      const system = String(requests[0]?.body.messages[0]?.content);
      assert.match(system, new RegExp(`happy-${nonce}`));
      assert.match(system, /untrusted data, not instructions/);
    });
    const followUp = `follow up ${nonce}`;
    fake.script(followUp, () => ({ kind: "text", text: "second answer" }));
    const secondRun = await chat.settled(await chat.send(followUp));
    await check("a second message sends the whole thread, with reasoning as a thinking chunk", () => {
      assert.equal(secondRun.state.kind, "done");
      const roles = fake.requests(followUp)[0]?.body.messages.map((message) => message.role);
      assert.deepEqual(roles, ["system", "user", "assistant", "tool", "assistant", "user"]);
      const assistant = fake.requests(followUp)[0]?.body.messages[4];
      assert.match(JSON.stringify(assistant?.content), /"type":"thinking"/);
    });
  });

  await scenario("tools. read_file and write_file", async () => {
    const chat = await newChat({ client: first, name: "files" });
    const text = `files ${nonce}`;
    const content = `line "one" $(touch /tmp/injected-${nonce}) 'quoted'\nline two é\n`;
    fake.script(text, ({ toolResults }) => {
      switch (toolResults.length) {
        case 0:
          return {
            kind: "tools",
            delivery: "whole",
            calls: [{ name: "write_file", arguments: JSON.stringify({ path: "nested/dir/a.txt", content }) }],
          };
        case 1:
          return {
            kind: "tools",
            delivery: "whole",
            calls: [
              {
                name: "read_file",
                arguments: JSON.stringify({ path: `/workspace/${chat.botId}/nested/dir/a.txt` }),
              },
            ],
          };
        case 2:
          return {
            kind: "tools",
            delivery: "pieces",
            calls: [{ name: "read_file", arguments: JSON.stringify({ path: "does/not/exist" }) }],
          };
        default:
          return { kind: "text", text: "done" };
      }
    });
    const run = await chat.settled(await chat.send(text));
    const results = resultsOf(run);
    await check("write_file creates parent directories and reports the bytes", () => {
      assert.equal(results[0]?.outcome, "ok");
      assert.match(results[0]?.output ?? "", /^Wrote \d+ bytes/);
    });
    await check("read_file returns the exact content through an absolute path", () => {
      assert.equal(results[1]?.outcome, "ok");
      assert.equal(results[1]?.output, content);
    });
    await check("content never reached a shell", () => {
      assert.equal(shellResult(mainContainer.id, `test -e /tmp/injected-${nonce}`).ok, false);
    });
    await check("read_file of a missing file is an error with its exit code", () => {
      assert.equal(results[2]?.outcome, "error");
      assert.equal(results[2]?.exitCode, 1);
      assert.match(results[2]?.output ?? "", /No such file/);
    });
  });

  await scenario("C. the roadmap check: SIGKILL the orchestrator mid-tool", async () => {
    const chat = await newChat({ client: first, name: "kill-mid-tool" });
    const text = `kill mid tool ${nonce}`;
    const path = workspaceFile(chat, "c.txt");
    const firstLine = `first-${nonce}`;
    const secondLine = `second-${nonce}`;
    const marker = `marker-${nonce}`;
    fake.script(text, ({ toolResults }) =>
      toolResults.length === 0
        ? {
            kind: "tools",
            delivery: "pieces",
            calls: [shellCall(`echo ${firstLine} >> c.txt; sleep 8; echo ${secondLine} >> c.txt; echo ${marker}`)],
          }
        : { kind: "text", text: "finished after the crash" },
    );
    const runId = await chat.send(text);
    await waitFor({
      description: "the first line in the file",
      probe: () => (linesOf({ container: mainContainer.id, path }).includes(firstLine) ? true : null),
    });
    await killOrchestrator();
    await check("the orchestrator is gone while the first line exists and the second does not", () => {
      assert.equal(orchestrator, null);
      assert.deepEqual(linesOf({ container: mainContainer.id, path }), [firstLine]);
    });
    await check("the command is still running in computerd", () => {
      assert.ok(agentProcessRunning({ container: mainContainer.id, pattern: secondLine }), "no process matched");
    });
    await startOrchestrator();
    const run = await chat.settled(runId);
    const lines = linesOf({ container: mainContainer.id, path });
    const requests = fake.requests(text);
    await check("the run resumes and ends done", () => assert.equal(run.state.kind, "done"));
    await check("each line appears exactly once in the file", () => {
      assert.deepEqual(lines, [firstLine, secondLine]);
    });
    await check("one assistantTurn lists the tool call, followed by one final turn", () => {
      const turns = turnsOf(run);
      assert.equal(turns.length, 2);
      assert.equal(turns[0]?.toolCalls.length, 1);
      assert.equal(turns[1]?.toolCalls.length, 0);
    });
    await check("one toolResult has outcome ok and the marker", () => {
      const results = resultsOf(run);
      assert.equal(results.length, 1);
      assert.equal(results[0]?.outcome, "ok");
      assert.match(results[0]?.output ?? "", new RegExp(marker));
    });
    await check("the fake model got the result after the crash, and was not asked to repeat the turn", () => {
      assert.equal(requests.length, 2);
      assert.match(toolMessagesText(requests[1]), new RegExp(`outcome: ok[\\s\\S]*${marker}`));
    });
    await check("seq has no gaps after recovery", () => {
      assert.deepEqual(
        run.events.map((event) => event.seq),
        run.events.map((_, index) => index),
      );
    });
  });

  await scenario("D. SIGKILL the orchestrator during a stalled model stream", async () => {
    const chat = await newChat({ client: first, name: "kill-stream" });
    const text = `kill stream ${nonce}`;
    const partial = `partial-${nonce}`;
    const final = `final-${nonce}`;
    fake.script(text, ({ attempt }) =>
      attempt === 1 ? { kind: "stall", partial } : { kind: "text", text: final },
    );
    const runId = await chat.send(text);
    await waitFor({
      description: "the partial stream row",
      probe: async () => ((await chat.run(runId))?.stream?.text === partial ? true : null),
    });
    await check("the partial text is in a stream row before the kill", () => {
      assert.equal(streamRows(runId).length, 1);
    });
    await killOrchestrator();
    await startOrchestrator();
    const run = await chat.settled(runId);
    await check("the model is called again after the restart", () => {
      assert.equal(fake.requests(text).length, 2);
    });
    await check("exactly one assistantTurn exists, with the second attempt's text", () => {
      const turns = turnsOf(run);
      assert.equal(turns.length, 1);
      assert.equal(turns[0]?.text, final);
    });
    await check("no runStreams row is left", () => assert.deepEqual(streamRows(runId), []));
    await check("the run is done", () => assert.equal(run.state.kind, "done"));
  });

  await scenario("E. docker kill computerd mid-tool", async () => {
    const chat = await newChat({ client: first, name: "kill-computerd" });
    const text = `kill computerd ${nonce}`;
    const path = workspaceFile(chat, "e.txt");
    const firstLine = `e-first-${nonce}`;
    const secondLine = `e-second-${nonce}`;
    fake.script(text, ({ toolResults }) =>
      toolResults.length === 0
        ? {
            kind: "tools",
            delivery: "pieces",
            calls: [shellCall(`echo ${firstLine} >> e.txt; sleep 6; echo ${secondLine} >> e.txt`)],
          }
        : { kind: "text", text: "noted the interruption" },
    );
    const runId = await chat.send(text);
    await waitFor({
      description: "the first line in the file",
      probe: () => (linesOf({ container: mainContainer.id, path }).includes(firstLine) ? true : null),
    });
    docker(["kill", mainContainer.id]);
    await sleep(500);
    docker(["start", mainContainer.id]);
    const run = await chat.settled(runId);
    await sleep(7000);
    await check("the outcome is interrupted and says the command may have partly run", () => {
      const [result] = resultsOf(run);
      assert.equal(result?.outcome, "interrupted");
      assert.match(result?.output ?? "", /may have partly run/);
    });
    await check("the side effect was not rerun, even after the original sleep would have ended", () => {
      assert.deepEqual(linesOf({ container: mainContainer.id, path }), [firstLine]);
    });
    await check("the model sees the interrupted outcome", () => {
      assert.match(toolMessagesText(fake.requests(text)[1]), /^outcome: interrupted/);
    });
    await check("the run is done", () => assert.equal(run.state.kind, "done"));
  });

  await scenario("F. journal replay, directly against computerd", async () => {
    const directPort = await findFreePort();
    const direct = startDirectLink(directPort);
    try {
      const container = startComputer({ project: DIRECT_PROJECT, linkPort: directPort });
      const botId = `direct${nonce}`;
      const path = `/workspace/${botId}/f.txt`;
      await direct.ready();
      await check("computerd's first message is hello with its token", () => {
        assert.equal(direct.connection.helloToken, COMPUTER_TOKEN);
      });
      const once = {
        kind: "toolCall",
        callId: `direct${nonce}:replay1`,
        botId,
        tool: { name: "shell", args: { command: "echo ran >> f.txt; echo first-answer", timeoutSeconds: 10 } },
      } as const;
      const firstAnswer = await direct.ask(once);
      const secondAnswer = await direct.ask(once);
      await check("the same toolCall twice returns the same result", () => {
        assert.equal(firstAnswer.outcome, "ok");
        assert.deepEqual(secondAnswer, firstAnswer);
      });
      await check("the side-effect file shows one execution", () => {
        assert.deepEqual(linesOf({ container, path }), ["ran"]);
      });
      docker(["restart", "--timeout", "1", container]);
      const afterRestart = await direct.ask(once);
      await check("the result replays after computerd restarts, still with one execution", () => {
        assert.deepEqual(afterRestart, firstAnswer);
        assert.deepEqual(linesOf({ container, path }), ["ran"]);
      });
      const slow = {
        kind: "toolCall",
        callId: `direct${nonce}:attach1`,
        botId,
        tool: { name: "shell", args: { command: "echo attached >> g.txt; sleep 2; echo slow-answer", timeoutSeconds: 10 } },
      } as const;
      const answers = await Promise.all([direct.ask(slow), direct.ask(slow)]);
      await check("a repeat during execution attaches to it instead of starting another", () => {
        assert.deepEqual(answers[0], answers[1]);
        assert.match(answers[0]?.output ?? "", /slow-answer/);
        assert.deepEqual(linesOf({ container, path: `/workspace/${botId}/g.txt` }), ["attached"]);
      });
      const cancelledFirst = await direct.ask({ kind: "cancelTool", callId: `direct${nonce}:never1` });
      const lateCall = await direct.ask({
        kind: "toolCall",
        callId: `direct${nonce}:never1`,
        botId,
        tool: { name: "shell", args: { command: "echo never >> never.txt", timeoutSeconds: 5 } },
      });
      await check("a cancel before the start stops the call from ever running", () => {
        assert.equal(cancelledFirst.outcome, "cancelled");
        assert.equal(lateCall.outcome, "cancelled");
        assert.deepEqual(linesOf({ container, path: `/workspace/${botId}/never.txt` }), []);
      });
      await check("the journal directory is owned by computerd with mode 0700", () => {
        assert.equal(shellIn(container, "stat -c '%U %a' /var/lib/computerd").trim(), "computerd 700");
      });
      await check("a user tool cannot read the journal without sudo", () => {
        assert.equal(shellResult(container, `sudo -n -u agent ls ${JOURNAL_DIR}`).ok, false);
      });
      await direct.sendRaw(JSON.stringify({ kind: "toolCall", callId: "../../etc:passwd", botId, tool: once.tool }));
      await waitFor({
        description: "computerd to close on a path-shaped callId",
        probe: () => (direct.connection.closes.includes(1008) ? true : null),
      });
      await check("computerd closes the link on a callId that could escape the journal", () => {
        assert.equal(shellResult(container, "test -e /var/lib/etc").ok, false);
      });
    } finally {
      direct.close();
      stopComputer(DIRECT_PROJECT);
    }
  });

  await scenario("G. fencing", async () => {
    const chat = await newChat({ client: second, name: "fencing" });
    const runId = await chat.send(`fencing ${nonce}`);
    await check("the orchestrator leaves another owner's run alone", async () => {
      await sleep(1000);
      assert.equal((await chat.run(runId))?.state.kind, "queued");
    });
    const firstClaim = await service.mutation(api.runs.claim, { runId });
    assert.ok(firstClaim.kind === "claimed");
    const staleToken = "stale-token";
    const body = { kind: "userMessage", text: "x" } as const;
    await check("a live lease cannot be claimed", async () => {
      assert.deepEqual(await service.mutation(api.runs.claim, { runId }), { kind: "unavailable" });
    });
    await check("append with a stale token is rejected", async () => {
      await assertRejected(
        service.mutation(api.runs.append, { runId, leaseToken: staleToken, expectedSeq: firstClaim.nextSeq, body }),
        /Lease lost/,
      );
    });
    await check("patchStream with a stale token is rejected", async () => {
      await assertRejected(
        service.mutation(api.runs.patchStream, { runId, leaseToken: staleToken, text: "x" }),
        /Lease lost/,
      );
    });
    await check("finish with a stale token is rejected", async () => {
      await assertRejected(
        service.mutation(api.runs.finish, { runId, leaseToken: staleToken, state: { kind: "done" } }),
        /Lease lost/,
      );
    });
    await check("heartbeat with a stale token reports the lease as lost", async () => {
      assert.deepEqual(await service.mutation(api.runs.heartbeat, { runId, leaseToken: staleToken }), { kind: "lost" });
    });
    await check("append with a wrong expectedSeq is rejected", async () => {
      await assertRejected(
        service.mutation(api.runs.append, {
          runId,
          leaseToken: firstClaim.leaseToken,
          expectedSeq: firstClaim.nextSeq + 5,
          body,
        }),
        /Expected seq/,
      );
    });
    await check("append with the right token and seq works, and a repeat of it is rejected", async () => {
      const args = { runId, leaseToken: firstClaim.leaseToken, expectedSeq: firstClaim.nextSeq, body };
      await service.mutation(api.runs.append, args);
      await assertRejected(service.mutation(api.runs.append, args), /Expected seq/);
    });
    await check("append removes the stream row in the same mutation", async () => {
      await service.mutation(api.runs.patchStream, { runId, leaseToken: firstClaim.leaseToken, text: "partial" });
      assert.equal(streamRows(runId).length, 1);
      await service.mutation(api.runs.append, {
        runId,
        leaseToken: firstClaim.leaseToken,
        expectedSeq: firstClaim.nextSeq + 1,
        body,
      });
      assert.equal(streamRows(runId).length, 0);
    });
    await check("heartbeat with the live token renews and carries cancelRequested", async () => {
      assert.deepEqual(await service.mutation(api.runs.heartbeat, { runId, leaseToken: firstClaim.leaseToken }), {
        kind: "renewed",
        cancelRequested: false,
      });
    });
    await sleep(LEASE_MS + 1000);
    const secondClaim = await service.mutation(api.runs.claim, { runId });
    await check("an expired lease can be claimed, with a fresh token", () => {
      assert.ok(secondClaim.kind === "claimed");
      assert.notEqual(secondClaim.leaseToken, firstClaim.leaseToken);
    });
    await check("the previous holder's writes are rejected after the reclaim", async () => {
      await assertRejected(
        service.mutation(api.runs.append, {
          runId,
          leaseToken: firstClaim.leaseToken,
          expectedSeq: firstClaim.nextSeq + 2,
          body,
        }),
        /Lease lost/,
      );
      await assertRejected(
        service.mutation(api.runs.finish, { runId, leaseToken: firstClaim.leaseToken, state: { kind: "done" } }),
        /Lease lost/,
      );
      assert.deepEqual(await service.mutation(api.runs.heartbeat, { runId, leaseToken: firstClaim.leaseToken }), {
        kind: "lost",
      });
    });
    await check("the new holder can finish, and a finished run cannot be claimed", async () => {
      assert.ok(secondClaim.kind === "claimed");
      await service.mutation(api.runs.finish, { runId, leaseToken: secondClaim.leaseToken, state: { kind: "done" } });
      assert.equal((await chat.run(runId))?.state.kind, "done");
      assert.deepEqual(await service.mutation(api.runs.claim, { runId }), { kind: "unavailable" });
    });
  });

  await scenario("G. a frozen runner that wakes after losing its lease writes nothing", async () => {
    const chat = await newChat({ client: first, name: "zombie" });
    const text = `zombie ${nonce}`;
    const toolCallId = "zombieId1";
    fake.script(text, ({ toolResults }) =>
      toolResults.length === 0
        ? { kind: "tools", delivery: "whole", calls: [{ id: toolCallId, ...shellCall("sleep 1; echo from-zombie") }] }
        : { kind: "text", text: "the zombie must never get here" },
    );
    const runId = await chat.send(text);
    await waitFor({
      description: "the assistant turn",
      probe: async () => {
        const entry = await chat.run(runId);
        return entry !== undefined && turnsOf(entry).length === 1 ? true : null;
      },
      intervalMs: 20,
    });
    orchestrator?.kill("SIGSTOP");
    await sleep(LEASE_MS + 1000);
    const takeover = await service.mutation(api.runs.claim, { runId });
    assert.ok(takeover.kind === "claimed");
    orchestrator?.kill("SIGCONT");
    await waitFor({
      description: "the runner to notice the lost lease",
      timeoutMs: 20_000,
      probe: () =>
        logsText().includes(`"event":"run-attempt-ended","runId":"${runId}"`) ||
        logsText().includes(`"event":"run-lease-lost","runId":"${runId}"`)
          ? true
          : null,
    });
    await sleep(2000);
    const run = await chat.run(runId);
    await check("the woken runner recorded no tool result", () => {
      assert.ok(run !== undefined);
      assert.equal(resultsOf(run).length, 0);
    });
    await check("the woken runner did not call the model again", () => {
      assert.equal(fake.requests(text).length, 1);
    });
    await check("the new holder's lease still works", async () => {
      assert.equal((await service.mutation(api.runs.heartbeat, { runId, leaseToken: takeover.leaseToken })).kind, "renewed");
      await service.mutation(api.runs.append, {
        runId,
        leaseToken: takeover.leaseToken,
        expectedSeq: takeover.nextSeq,
        body: { kind: "toolResult", toolCallId, name: "shell", outcome: "cancelled", output: "", truncated: false },
      });
      await service.mutation(api.runs.finish, { runId, leaseToken: takeover.leaseToken, state: { kind: "cancelled" } });
    });
  });

  await scenario("H and M. cancel mid-tool, and send during an active run", async () => {
    const chat = await newChat({ client: first, name: "cancel" });
    const text = `cancel ${nonce}`;
    const path = workspaceFile(chat, "h-heartbeat.txt");
    fake.script(text, ({ toolResults }) =>
      toolResults.length === 0
        ? {
            kind: "tools",
            delivery: "whole",
            calls: [
              shellCall(`(while true; do date +%s%N >> h-heartbeat.txt; sleep 1; done) & echo child-${nonce}; wait`),
            ],
          }
        : { kind: "text", text: "unreachable" },
    );
    const runId = await chat.send(text);
    await waitFor({
      description: "heartbeat lines from the background child",
      probe: () => (linesOf({ container: mainContainer.id, path }).length >= 2 ? true : null),
    });
    await check("threads.send during an active run is rejected", async () => {
      await assertRejected(chat.send(`second message ${nonce}`), /already has an active run/);
    });
    await check("the timeline shows no lease token to the user", async () => {
      const raw = JSON.stringify(await first.query(api.threads.timeline, { threadId: chat.threadId }));
      assert.ok(!raw.includes("leaseToken"));
      assert.ok(!raw.includes("leaseUntil"));
    });
    await first.mutation(api.runs.requestCancel, { runId });
    const run = await chat.settled(runId, 30_000);
    const atCancel = linesOf({ container: mainContainer.id, path }).length;
    await sleep(3000);
    await check("the run is cancelled", () => assert.equal(run.state.kind, "cancelled"));
    await check("the tool result has outcome cancelled and keeps the output so far", () => {
      const [result] = resultsOf(run);
      assert.equal(result?.outcome, "cancelled");
      assert.match(result?.output ?? "", new RegExp(`child-${nonce}`));
    });
    await check("the heartbeat stopped, so the whole process tree died", () => {
      assert.equal(linesOf({ container: mainContainer.id, path }).length, atCancel);
    });
    await check("no process from that command remains", () => {
      assert.equal(agentProcessRunning({ container: mainContainer.id, pattern: "h-heartbeat" }), false);
    });
    await check("the model was not called after the cancel", () => {
      assert.equal(fake.requests(text).length, 1);
    });
    await check("a queued run cancels at once with no runner", async () => {
      const secondChat = await newChat({ client: second, name: "cancel-queued" });
      const queued = await secondChat.send(`queued ${nonce}`);
      await second.mutation(api.runs.requestCancel, { runId: queued });
      assert.equal((await secondChat.run(queued))?.state.kind, "cancelled");
    });
    const stream = `cancel stream ${nonce}`;
    fake.script(stream, () => ({ kind: "stall", partial: "stuck" }));
    const streamRunId = await chat.send(stream);
    await waitFor({
      description: "the stalled stream",
      probe: async () => ((await chat.run(streamRunId))?.stream?.text === "stuck" ? true : null),
    });
    await first.mutation(api.runs.requestCancel, { runId: streamRunId });
    const streamRun = await chat.settled(streamRunId, 30_000);
    await check("cancel aborts a stalled model stream and leaves no stream row", () => {
      assert.equal(streamRun.state.kind, "cancelled");
      assert.equal(turnsOf(streamRun).length, 0);
      assert.deepEqual(streamRows(streamRunId), []);
    });
    const after = `after cancel ${nonce}`;
    fake.script(after, () => ({ kind: "text", text: "fine" }));
    const afterRun = await chat.settled(await chat.send(after));
    await check("the next message after a cancelled run keeps the roles alternating", () => {
      assert.equal(afterRun.state.kind, "done");
      const roles = fake.requests(after)[0]?.body.messages.map((message) => message.role) ?? [];
      assert.deepEqual(roles, ["system", "user", "assistant", "tool", "assistant", "user", "assistant", "user"]);
    });
  });

  await scenario("I. timeout and output cap", async () => {
    const chat = await newChat({ client: first, name: "timeout" });
    const text = `timeout ${nonce}`;
    const path = workspaceFile(chat, "i-heartbeat.txt");
    fake.script(text, ({ toolResults }) =>
      toolResults.length === 0
        ? {
            kind: "tools",
            delivery: "whole",
            calls: [shellCall(`(while true; do date +%s%N >> i-heartbeat.txt; sleep 1; done) & wait`, 3)],
          }
        : { kind: "text", text: "saw the timeout" },
    );
    const run = await chat.settled(await chat.send(text));
    const atEnd = linesOf({ container: mainContainer.id, path }).length;
    await sleep(3000);
    await check("the outcome is timeout", () => assert.equal(resultsOf(run)[0]?.outcome, "timeout"));
    await check("the heartbeat stopped, so the timeout killed the whole tree", () => {
      assert.ok(atEnd >= 1);
      assert.equal(linesOf({ container: mainContainer.id, path }).length, atEnd);
    });
    await check("the run continues after a timeout", () => {
      assert.equal(run.state.kind, "done");
      assert.match(toolMessagesText(fake.requests(text)[1]), /^outcome: timeout/);
    });

    // The ^ matters. PID 1 is the init process, and its command line also contains this path.
    const computerdPid = docker(["exec", mainContainer.id, "pgrep", "-f", "^node apps/computerd/src/main.ts"]).trim();
    const peakRssKiB = () =>
      Number(shellIn(mainContainer.id, `grep VmHWM /proc/${computerdPid}/status`).match(/\d+/)?.[0] ?? "0");
    const peakBefore = peakRssKiB();
    const flood = `flood ${nonce}`;
    fake.script(flood, ({ toolResults }) =>
      toolResults.length === 0
        ? { kind: "tools", delivery: "whole", calls: [shellCall("yes", 6)] }
        : { kind: "text", text: "saw the flood" },
    );
    const floodRun = await chat.settled(await chat.send(flood));
    const peakAfter = peakRssKiB();
    const floodResult = resultsOf(floodRun)[0];
    const omitted = Number(floodResult?.output.match(/\[\.\.\. (\d+) bytes omitted/)?.[1] ?? "0");
    await check("output over the cap is truncated with the flag set and a marker", () => {
      assert.equal(floodResult?.outcome, "timeout");
      assert.equal(floodResult?.truncated, true);
      assert.ok(Buffer.byteLength(floodResult?.output ?? "", "utf8") <= OUTPUT_CAP_BYTES);
      assert.ok(floodResult?.output.startsWith("y\ny\n"));
      assert.ok(floodResult?.output.endsWith("y\n"));
    });
    await check(
      `computerd's peak memory stayed bounded (${Math.round(peakBefore / 1024)} to ${Math.round(peakAfter / 1024)} MiB) while yes printed ${Math.round(omitted / 1048576)} MiB`,
      () => {
        assert.ok(omitted > 256 * 1048576, `yes printed only ${omitted} bytes, which proves nothing`);
        assert.ok(peakBefore > 10 * 1024, `measured ${peakBefore} KiB, which is not the computerd process`);
        assert.ok(peakAfter < 256 * 1024, `peak was ${peakAfter} KiB`);
      },
    );
    await check("the model is told the output was truncated", () => {
      assert.match(toolMessagesText(fake.requests(flood)[1]), /output truncated: yes/);
    });
  });

  await scenario("J. invalid calls and model failures", async () => {
    const chat = await newChat({ client: first, name: "failures" });
    const text = `invalid ${nonce}`;
    const validMarker = `valid-${nonce}`;
    const ids = { badJson: "badJson01", badSchema: "badSchema", unknown: "unknown01", valid: "validCall" };
    fake.script(text, ({ toolResults }) =>
      toolResults.length === 0
        ? {
            kind: "tools",
            delivery: "whole",
            calls: [
              { id: ids.badJson, name: "shell", arguments: "{not json" },
              { id: ids.badSchema, name: "shell", arguments: '{"cmd":"rm -rf /"}' },
              { id: ids.unknown, name: "delete_everything", arguments: "{}" },
              { id: ids.valid, ...shellCall(`echo ${validMarker}`) },
            ],
          }
        : { kind: "text", text: "corrected" },
    );
    const runId = await chat.send(text);
    const run = await chat.settled(runId);
    const results = resultsOf(run);
    await check("bad JSON, a schema mismatch, and an unknown tool each get outcome invalid", () => {
      assert.deepEqual(results.slice(0, 3).map((result) => result.outcome), ["invalid", "invalid", "invalid"]);
      assert.match(results[0]?.output ?? "", /not valid JSON/);
      assert.match(results[1]?.output ?? "", /do not match/);
      assert.match(results[2]?.output ?? "", /no tool named/);
    });
    await check("calls in one turn run in order, and the valid one still runs", () => {
      assert.deepEqual(results.map((result) => result.toolCallId), [ids.badJson, ids.badSchema, ids.unknown, ids.valid]);
      assert.equal(results[3]?.outcome, "ok");
      assert.match(results[3]?.output ?? "", new RegExp(validMarker));
    });
    await check("the invalid calls never reached computerd, and the valid one did", () => {
      const journal = shellIn(mainContainer.id, `ls ${JOURNAL_DIR}`);
      for (const id of [ids.badJson, ids.badSchema, ids.unknown]) {
        assert.ok(!journal.includes(callIdToFileStem(`${runId}:${id}`)), `${id} has a journal entry`);
      }
      assert.ok(journal.includes(callIdToFileStem(`${runId}:${ids.valid}`)));
    });
    await check("the model hears the invalid outcome so it can correct itself", () => {
      assert.match(toolMessagesText(fake.requests(text)[1]), /outcome: invalid/);
    });

    const rejected = `rejected ${nonce}`;
    fake.script(rejected, () => ({ kind: "status", status: 401 }));
    const rejectedRun = await chat.settled(await chat.send(rejected));
    await check("a 401 fails the run with the rejection reason", () => {
      assert.equal(rejectedRun.state.kind, "failed");
      assert.match(rejectedRun.state.kind === "failed" ? rejectedRun.state.reason : "", /rejected the API key/);
    });
    await check("a 401 is not retried", () => assert.equal(fake.requests(rejected).length, 1));

    const flaky = `flaky ${nonce}`;
    fake.script(flaky, ({ attempt }) =>
      attempt === 1 ? { kind: "status", status: 503, retryAfter: "2" } : { kind: "text", text: "recovered" },
    );
    const flakyRun = await chat.settled(await chat.send(flaky));
    const flakyRequests = fake.requests(flaky);
    await check("a 503 then success retries and completes", () => {
      assert.equal(flakyRun.state.kind, "done");
      assert.equal(flakyRequests.length, 2);
      assert.equal(turnsOf(flakyRun)[0]?.text, "recovered");
    });
    await check("the retry waits as long as Retry-After asks, past the 1 s backoff", () => {
      assert.ok((flakyRequests[1]?.at ?? 0) - (flakyRequests[0]?.at ?? 0) >= 1900);
    });

    const down = `down ${nonce}`;
    fake.script(down, () => ({ kind: "status", status: 500 }));
    const downRun = await chat.settled(await chat.send(down));
    await check("persistent 5xx stops after 5 attempts with a reason", () => {
      assert.equal(downRun.state.kind, "failed");
      assert.equal(fake.requests(down).length, 5);
      assert.match(downRun.state.kind === "failed" ? downRun.state.reason : "", /after 5 attempts/);
    });

    const invalidRequest = `bad request ${nonce}`;
    fake.script(invalidRequest, () => ({ kind: "status", status: 422 }));
    const invalidRun = await chat.settled(await chat.send(invalidRequest));
    await check("a 4xx other than 401 and 403 fails at once and names the status", () => {
      assert.equal(invalidRun.state.kind, "failed");
      assert.equal(fake.requests(invalidRequest).length, 1);
      assert.match(invalidRun.state.kind === "failed" ? invalidRun.state.reason : "", /422/);
    });
  });

  await scenario("waiting. a computer that stays away", async () => {
    const chat = await newChat({ client: first, name: "unavailable" });
    const text = `unavailable ${nonce}`;
    const path = workspaceFile(chat, "away.txt");
    fake.script(text, ({ toolResults }) =>
      toolResults.length === 0
        ? { kind: "tools", delivery: "whole", calls: [shellCall("echo ran >> away.txt")] }
        : { kind: "text", text: "the computer was away" },
    );
    docker(["stop", "--timeout", "1", mainContainer.id]);
    const startedAt = Date.now();
    const run = await chat.settled(await chat.send(text));
    const elapsed = Date.now() - startedAt;
    docker(["start", mainContainer.id]);
    await check(`the run waited through more than one lease (${Math.round(elapsed / 1000)} s) for the computer`, () => {
      assert.ok(elapsed >= COMPUTER_WAIT_SECONDS * 1000);
    });
    await check("the outcome is unavailable, and the model sees it", () => {
      assert.equal(resultsOf(run)[0]?.outcome, "unavailable");
      assert.match(toolMessagesText(fake.requests(text)[1]), /^outcome: unavailable/);
    });
    await check("the lease held, so the turn was not repeated", () => {
      assert.equal(turnsOf(run).length, 2);
      assert.equal(fake.requests(text).length, 2);
      assert.equal(run.state.kind, "done");
    });
    await check("the call did not run later when the computer returned", async () => {
      await sleep(3000);
      assert.deepEqual(linesOf({ container: mainContainer.id, path }), []);
    });
  });

  await scenario("K. link security", async () => {
    const http = await fetch(`http://${LOOPBACK}:${linkPort}/auth/token`);
    await check("the link listener serves no HTTP, so neither /auth nor web files", async () => {
      assert.equal(http.status, 426);
      assert.ok(!(await http.text()).includes("token"));
    });
    await service.mutation(api.computers.register, {
      ownerSubject: SECOND_SUBJECT,
      email: `${SECOND_SUBJECT}@verify`,
      displayName: SECOND_SUBJECT,
      tokenHash: hashComputerToken(SECOND_COMPUTER_TOKEN),
    });
    await check("a wrong token is closed", async () => {
      const probe = openLink(linkPort);
      await probe.opened;
      probe.socket.send(JSON.stringify({ kind: "hello", token: "wrong-token" }));
      assert.equal(await probe.closed, 4001);
      assert.deepEqual(probe.messages, []);
    });
    await check("a socket that never says hello is closed within the timeout", async () => {
      const probe = openLink(linkPort);
      await probe.opened;
      const startedAt = Date.now();
      assert.equal(await probe.closed, 1008);
      assert.ok(Date.now() - startedAt < 7000);
    });
    await check("a first message that is not hello closes the socket", async () => {
      const probe = openLink(linkPort);
      await probe.opened;
      probe.socket.send(
        JSON.stringify({ kind: "toolResult", callId: "a:b", result: { outcome: "ok", output: "", truncated: false } }),
      );
      assert.equal(await probe.closed, 1008);
    });
    await check("an invalid message closes the socket", async () => {
      const probe = await helloLink(SECOND_COMPUTER_TOKEN);
      probe.socket.send("{not json");
      assert.equal(await probe.closed, 1008);
    });
    await check("a schema mismatch closes the socket", async () => {
      const probe = await helloLink(SECOND_COMPUTER_TOKEN);
      probe.socket.send(
        JSON.stringify({
          kind: "toolResult",
          callId: "a:b",
          result: { outcome: "unavailable", output: "", truncated: false },
        }),
      );
      assert.equal(await probe.closed, 1008);
    });
    await check("a message over maxPayload closes the socket", async () => {
      const probe = await helloLink(SECOND_COMPUTER_TOKEN);
      probe.socket.send("x".repeat(1024 * 1024));
      assert.equal(await probe.closed, 1009);
    });
    await check("a newer connection replaces the older one", async () => {
      const older = await helloLink(SECOND_COMPUTER_TOKEN);
      const newer = await helloLink(SECOND_COMPUTER_TOKEN);
      assert.equal(await older.closed, 4000);
      assert.equal(newer.socket.readyState, WebSocket.OPEN);
      newer.socket.close();
      await newer.closed;
    });
    await check("those probes never displaced the real computer", () => {
      assert.ok(!docker(["logs", mainContainer.id]).includes('"code":4000'));
    });

    const chat = await newChat({ client: first, name: "forged" });
    const text = `forged ${nonce}`;
    const toolCallId = "forgedId1";
    fake.script(text, ({ toolResults }) =>
      toolResults.length === 0
        ? {
            kind: "tools",
            delivery: "whole",
            calls: [{ id: toolCallId, ...shellCall(`sleep 3; echo real-${nonce}`) }],
          }
        : { kind: "text", text: "got the real result" },
    );
    const runId = await chat.send(text);
    await waitFor({
      description: "the tool call to be recorded",
      probe: async () => {
        const entry = await chat.run(runId);
        return entry !== undefined && turnsOf(entry).length === 1 ? true : null;
      },
    });
    const forger = await helloLink(SECOND_COMPUTER_TOKEN);
    const before = await chat.run(runId);
    forger.socket.send(
      JSON.stringify({
        kind: "toolResult",
        callId: `${runId}:${toolCallId}`,
        result: { outcome: "ok", output: `forged-${nonce}`, truncated: false },
      }),
    );
    await check("another owner's result for a live call is rejected by closing that socket", async () => {
      assert.equal(await forger.closed, 1008);
    });
    await check("the forged result changed nothing", async () => {
      assert.deepEqual((await chat.run(runId))?.events, before?.events);
    });
    const run = await chat.settled(runId);
    await check("the run finishes with the real result", () => {
      const [result] = resultsOf(run);
      assert.equal(result?.outcome, "ok");
      assert.match(result?.output ?? "", new RegExp(`real-${nonce}`));
      assert.ok(!JSON.stringify(run).includes(`forged-${nonce}`));
      assert.equal(resultsOf(run).length, 1);
    });
    if (happyChat !== null && happyRunId !== null) {
      const unchanged = await happyChat.run(happyRunId);
      const replay = await helloLink(SECOND_COMPUTER_TOKEN);
      replay.socket.send(
        JSON.stringify({
          kind: "toolResult",
          callId: `${happyRunId}:neverIssued`,
          result: { outcome: "ok", output: "never", truncated: false },
        }),
      );
      await check("a result for a callId never issued is rejected and changes nothing", async () => {
        assert.equal(await replay.closed, 1008);
        assert.deepEqual(await happyChat?.run(happyRunId as Id<"runs">), unchanged);
      });
    }
  });

  await scenario("L. isolation", async () => {
    const chat = await newChat({ client: first, name: "isolation" });
    const text = `isolation ${nonce}`;
    fake.script(text, () => ({ kind: "text", text: "private" }));
    const runId = await chat.send(text);
    await chat.settled(runId);
    await second.mutation(api.users.ensureCurrent, {});
    await check("another identity cannot read the timeline", async () => {
      await assertRejected(second.query(api.threads.timeline, { threadId: chat.threadId }), /Thread not found/);
    });
    await check("another identity cannot send", async () => {
      await assertRejected(second.mutation(api.threads.send, { threadId: chat.threadId, text: "hi" }), /Thread not found/);
    });
    await check("another identity cannot cancel", async () => {
      await assertRejected(second.mutation(api.runs.requestCancel, { runId }), /Run not found/);
    });
    await check("another identity cannot open a thread on the bot, or read the bot", async () => {
      await assertRejected(second.mutation(api.threads.ensureForBot, { botId: chat.botId }), /Bot not found/);
      assert.equal(await second.query(api.bots.get, { botId: chat.botId }), null);
    });
    await check("another identity sees its own credentials status, not the first user's", async () => {
      assert.deepEqual(await first.query(api.credentials.status, {}), {
        configured: true,
        last4: MISTRAL_KEY.slice(-4),
      });
      assert.deepEqual(await second.query(api.credentials.status, {}), { configured: false, last4: null });
    });
    await check("bots.get treats a malformed id as a missing bot", async () => {
      assert.equal(await first.query(api.bots.get, { botId: "nonsense" }), null);
    });

    const fence = { runId, leaseToken: "x" };
    const serviceCalls: [string, (client: ConvexHttpClient) => Promise<unknown>][] = [
      ["runs.listQueued", (client) => client.query(api.runs.listQueued, {})],
      ["runs.listClaimable", (client) => client.query(api.runs.listClaimable, { now: 0 })],
      ["runs.claim", (client) => client.mutation(api.runs.claim, { runId })],
      ["runs.heartbeat", (client) => client.mutation(api.runs.heartbeat, fence)],
      [
        "runs.append",
        (client) =>
          client.mutation(api.runs.append, { ...fence, expectedSeq: 0, body: { kind: "userMessage", text: "x" } }),
      ],
      ["runs.patchStream", (client) => client.mutation(api.runs.patchStream, { ...fence, text: "x" })],
      ["runs.finish", (client) => client.mutation(api.runs.finish, { ...fence, state: { kind: "done" } })],
      [
        "threads.eventsPage",
        (client) =>
          client.query(api.threads.eventsPage, {
            threadId: chat.threadId,
            paginationOpts: { numItems: 1, cursor: null },
          }),
      ],
      [
        "computers.register",
        (client) =>
          client.mutation(api.computers.register, {
            ownerSubject: "dev:forged@localhost",
            email: "forged@localhost",
            displayName: "forged",
            tokenHash: "forged",
          }),
      ],
      ["computers.byTokenHash", (client) => client.query(api.computers.byTokenHash, { tokenHash: "x" })],
      [
        "credentials.store",
        (client) =>
          client.mutation(api.credentials.store, {
            ownerId,
            ciphertext: "x",
            iv: "x",
            tag: "x",
            keyVersion: 1,
            last4: "x",
          }),
      ],
      ["credentials.remove", (client) => client.mutation(api.credentials.remove, { ownerId })],
      ["credentials.ciphertextFor", (client) => client.query(api.credentials.ciphertextFor, { ownerId })],
      [
        "users.ensureForService",
        (client) =>
          client.mutation(api.users.ensureForService, { subject: "dev:forged@localhost", email: "x", displayName: "x" }),
      ],
    ];
    for (const [name, call] of serviceCalls) {
      await check(`a user token cannot call ${name}`, async () => {
        await assertRejected(call(first), /Not authorized/);
      });
      await check(`no token cannot call ${name}`, async () => {
        await assertRejected(call(anonymous), /Not authorized/);
      });
    }
    await check("the first user's key survived those attempts", async () => {
      const row = await service.query(api.credentials.ciphertextFor, { ownerId });
      assert.equal(row !== null && decryptApiKey({ masterKey, ownerId, encrypted: row }), MISTRAL_KEY);
    });
  });

  await scenario("N. where secrets are not", async () => {
    const chat = await newChat({ client: first, name: "secrets" });
    const text = `env ${nonce}`;
    fake.script(text, ({ toolResults }) =>
      toolResults.length === 0
        ? {
            kind: "tools",
            delivery: "whole",
            calls: [shellCall("env; echo SECOND-PART; sudo -n cat /proc/1/environ | tr '\\0' '\\n'")],
          }
        : { kind: "text", text: "ok" },
    );
    const runId = await chat.send(text);
    const run = await chat.settled(runId);
    const output = resultsOf(run)[0]?.output ?? "";
    const forbidden = /MISTRAL|MASTER_KEY|CONVEX/;
    await check("a tool running env sees no Mistral, master key, or Convex variable", () => {
      assert.equal(resultsOf(run)[0]?.outcome, "ok");
      assert.match(output, /SECOND-PART/);
      assert.ok(!forbidden.test(output), "a forbidden name appeared");
    });
    await check("docker inspect shows no Mistral, master key, or Convex variable", () => {
      const env = docker(["inspect", "--format", "{{json .Config.Env}}", mainContainer.id]);
      assert.ok(!forbidden.test(env), "a forbidden name appeared");
      assert.match(env, /COMPUTER_TOKEN/);
    });
    await check("the Mistral key appears nowhere in the orchestrator's logs", () => {
      assert.ok(logsText().length > 0);
      assert.ok(!logsText().includes(MISTRAL_KEY));
      assert.ok(!logsText().includes(REJECTED_KEY));
    });
    await check("the computer token and master key appear nowhere in the orchestrator's logs", () => {
      assert.ok(!logsText().includes(COMPUTER_TOKEN));
      assert.ok(!logsText().includes(SECOND_COMPUTER_TOKEN));
      assert.ok(!logsText().includes(MASTER_KEY));
    });
    await check("computerd's logs hold no token and no command output", () => {
      const logs = docker(["logs", mainContainer.id]);
      assert.ok(logs.includes("tool-call"));
      assert.ok(!logs.includes(COMPUTER_TOKEN));
      assert.ok(!logs.includes(`child-${nonce}`));
      assert.ok(!logs.includes("SECOND-PART"));
    });
    await check("the Mistral key appears in no runEvents row", async () => {
      for (const client of [chat, happyChat]) {
        if (client === null) {
          continue;
        }
        const page = await service.query(api.threads.eventsPage, {
          threadId: client.threadId,
          paginationOpts: { numItems: 100, cursor: null },
        });
        assert.ok(page.page.length > 0);
        assert.ok(!JSON.stringify(page.page).includes(MISTRAL_KEY));
      }
    });
    await check("the failure reasons recorded today hold no key", () => {
      assert.ok(!JSON.stringify(run).includes(MISTRAL_KEY));
    });
    await check("the computerd image holds no secrets from the repository", () => {
      assert.equal(shellResult(mainContainer.id, "test -e /app/.env.local").ok, false);
      assert.equal(shellResult(mainContainer.id, "test -e /app/packages/convex").ok, false);
    });
  });
} catch (error) {
  failures += 1;
  console.log(`FAIL  setup: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await killOrchestrator();
  fake.close();
  for (const project of [COMPUTER_PROJECT, DIRECT_PROJECT]) {
    try {
      stopComputer(project);
    } catch (error) {
      failures += 1;
      console.log(`FAIL  could not stop ${project}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

console.log(failures === 0 ? "verify:agent passed" : `verify:agent failed with ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
