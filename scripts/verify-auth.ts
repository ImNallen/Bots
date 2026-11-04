import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { createConnection, createServer } from "node:net";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";
import { api } from "@bots/convex";
import { ConvexClient, ConvexHttpClient } from "convex/browser";
import type { FunctionReturnType } from "convex/server";
import {
  SignJWT,
  createLocalJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  generateKeyPair,
  importJWK,
  jwtVerify,
  type JSONWebKeySet,
} from "jose";
import {
  parseConvexEnvList,
  parsePrivateJwk,
  paths,
  readEnvFile,
  runConvex,
} from "./lib.ts";

const SUBSCRIPTION_TIMEOUT_MS = 10_000;
const WATCHDOG_MS = 120_000;
const LOOPBACK = "127.0.0.1";
const VERIFY_LOGIN = "verify@localhost";
const SECOND_SUBJECT = "dev:verify-second@localhost";

type Bots = FunctionReturnType<typeof api.bots.list>;

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

type HttpResponse = { status: number; headers: Record<string, unknown>; body: string };

// node:http sends the path and Host exactly as given, which fetch would normalize or refuse.
function rawGet(args: {
  port: number;
  path: string;
  headers?: Record<string, string>;
}): Promise<HttpResponse> {
  return new Promise((resolvePromise, reject) => {
    const outgoing = request(
      { host: LOOPBACK, port: args.port, path: args.path, method: "GET", headers: args.headers ?? {} },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () =>
          resolvePromise({
            status: incoming.statusCode ?? 0,
            headers: incoming.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

function findFreePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, LOOPBACK, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("could not read the free port"));
        return;
      }
      server.close(() => resolvePromise(address.port));
    });
  });
}

function refusesConnection(args: { host: string; port: number }): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ host: args.host, port: args.port, timeout: 2000 });
    socket.on("connect", () => {
      socket.destroy();
      resolvePromise(false);
    });
    socket.on("error", () => resolvePromise(true));
    socket.on("timeout", () => {
      socket.destroy();
      resolvePromise(true);
    });
  });
}

function lanAddress(): string | null {
  const addresses = Object.values(networkInterfaces()).flat();
  return addresses.find((entry) => entry?.family === "IPv4" && !entry.internal)?.address ?? null;
}

async function startOrchestrator(args: { port: number; env: Record<string, string | undefined> }) {
  const child = spawn(process.execPath, [paths.orchestratorMain], {
    env: { ...process.env, ...args.env, AUTH_MODE: "dev", DEV_LOGIN: VERIFY_LOGIN, PORT: String(args.port) },
    stdio: ["ignore", "ignore", "inherit"],
  });
  const deadline = Date.now() + SUBSCRIPTION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const healthy = await rawGet({ port: args.port, path: "/healthz" }).then(
      (response) => response.status === 200,
      () => false,
    );
    if (healthy) {
      return child;
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  child.kill();
  throw new Error("the orchestrator did not become healthy");
}

function watchBots(client: ConvexClient) {
  const updates: Bots[] = [];
  const waiters = new Set<() => void>();
  const unsubscribe = client.onUpdate(api.bots.list, {}, (bots) => {
    updates.push(bots);
    for (const waiter of waiters) {
      waiter();
    }
  });
  function until(args: { description: string; matches: (bots: Bots) => boolean }): Promise<Bots> {
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error(`no subscription update where ${args.description}`));
      }, SUBSCRIPTION_TIMEOUT_MS);
      const waiter = () => {
        const latest = updates.at(-1);
        if (latest !== undefined && args.matches(latest)) {
          clearTimeout(timer);
          waiters.delete(waiter);
          resolvePromise(latest);
        }
      };
      waiters.add(waiter);
      waiter();
    });
  }
  return { updates, until, unsubscribe };
}

function authenticatedClient(args: { url: string; token: string }): ConvexClient {
  const client = new ConvexClient(args.url, { logger: false });
  client.setAuth(async () => args.token);
  return client;
}

async function assertQueryRejected(args: {
  url: string;
  token: string | null;
  expected: RegExp;
}): Promise<void> {
  const client = new ConvexHttpClient(args.url);
  if (args.token !== null) {
    client.setAuth(args.token);
  }
  await assert.rejects(client.query(api.bots.list, {}), args.expected);
}

const runId = randomBytes(4).toString("hex");
const rootEnv = readEnvFile(paths.rootEnv);
const convexUrl = readEnvFile(paths.convexEnv).CONVEX_SELF_HOSTED_URL;
if (rootEnv.JWT_PRIVATE_JWK === undefined || convexUrl === undefined) {
  console.error("FAIL  .env.local is incomplete. Run pnpm bootstrap first.");
  process.exit(1);
}
const privateJwk = parsePrivateJwk(rootEnv.JWT_PRIVATE_JWK);
const signingKey = await importJWK(privateJwk, "ES256");

setTimeout(() => {
  console.error(`FAIL  verify:auth did not finish within ${WATCHDOG_MS} ms`);
  process.exit(1);
}, WATCHDOG_MS).unref();

const port = await findFreePort();
const orchestrator = await startOrchestrator({ port, env: rootEnv });
const clients: ConvexClient[] = [];

try {
  const tokenResponse = await rawGet({ port, path: "/auth/token" });
  assert.equal(tokenResponse.status, 200, "GET /auth/token did not return 200");
  const tokenBody: unknown = JSON.parse(tokenResponse.body);
  assert.ok(typeof tokenBody === "object" && tokenBody !== null && "token" in tokenBody && "expiresAt" in tokenBody);
  const { token: firstToken, expiresAt } = tokenBody;
  assert.ok(typeof firstToken === "string");
  const firstClaims = decodeJwt(firstToken);
  const { iss, aud } = firstClaims;
  assert.ok(typeof iss === "string" && typeof aud === "string");

  const signToken = async (args: {
    subject: string;
    key?: Parameters<SignJWT["sign"]>[0];
    audience?: string;
    issuer?: string;
    issuedAt?: number;
    expiresAt?: number;
  }): Promise<string> => {
    const now = Math.floor(Date.now() / 1000);
    return await new SignJWT({ email: `${args.subject}@verify`, name: args.subject })
      .setProtectedHeader({ alg: "ES256", kid: privateJwk.kid, typ: "JWT" })
      .setSubject(args.subject)
      .setIssuer(args.issuer ?? iss)
      .setAudience(args.audience ?? aud)
      .setIssuedAt(args.issuedAt ?? now)
      .setExpirationTime(args.expiresAt ?? now + 3600)
      .sign(args.key ?? signingKey);
  };

  await check("GET /auth/token sets Cache-Control: no-store and no CORS headers", () => {
    assert.equal(tokenResponse.headers["cache-control"], "no-store");
    assert.equal(tokenResponse.headers["access-control-allow-origin"], undefined);
  });

  await check("token header has kid, alg ES256, and typ JWT", () => {
    const header = decodeProtectedHeader(firstToken);
    assert.equal(header.alg, "ES256");
    assert.equal(header.typ, "JWT");
    assert.equal(header.kid, privateJwk.kid);
  });

  await check("token payload has sub, iss, aud, iat, and exp, with a one hour lifetime", () => {
    assert.equal(firstClaims.sub, `dev:${VERIFY_LOGIN}`);
    assert.equal(typeof firstClaims.iss, "string");
    assert.equal(typeof firstClaims.aud, "string");
    const { iat, exp } = firstClaims;
    assert.ok(typeof iat === "number" && typeof exp === "number", "iat or exp is missing");
    assert.equal(exp, expiresAt);
    assert.equal(exp - iat, 3600);
  });

  await check("token verifies against the JWKS published in the Convex deployment", async () => {
    const list = runConvex(["env", "list", "--include-values"]);
    assert.ok(list.kind === "ok", "convex env list failed");
    const dataUri = parseConvexEnvList(list.stdout).get("JWT_JWKS");
    assert.ok(
      dataUri !== undefined && dataUri.startsWith("data:text/plain;charset=utf-8;base64,"),
      "JWT_JWKS is not a data URI",
    );
    const encoded = dataUri.slice(dataUri.indexOf(",") + 1);
    const jwks: JSONWebKeySet = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    assert.ok(jwks.keys.every((key) => key.d === undefined), "the published JWKS holds a private key");
    await jwtVerify(firstToken, createLocalJWKSet(jwks), { issuer: iss, audience: aud, algorithms: ["ES256"] });
  });

  const clientA = authenticatedClient({ url: convexUrl, token: firstToken });
  const clientB = authenticatedClient({ url: convexUrl, token: firstToken });
  clients.push(clientA, clientB);
  const firstBotName = `verify-first-${runId}`;
  const secondBotName = `verify-second-${runId}`;
  await clientB.mutation(api.users.ensureCurrent, {});
  const watchA = watchBots(clientA);

  await check("client A's subscription delivers an initial list without the new bot", async () => {
    const initial = await watchA.until({ description: "the first list arrives", matches: () => true });
    assert.ok(!initial.some((bot) => bot.name === firstBotName));
  });

  await check("client A's subscription receives client B's new bot with no refetch", async () => {
    const updatesBefore = watchA.updates.length;
    await clientB.mutation(api.bots.create, { name: firstBotName });
    await watchA.until({
      description: "the new bot appears",
      matches: (bots) => bots.some((bot) => bot.name === firstBotName),
    });
    assert.ok(watchA.updates.length > updatesBefore);
  });

  const secondClient = authenticatedClient({
    url: convexUrl,
    token: await signToken({ subject: SECOND_SUBJECT }),
  });
  clients.push(secondClient);
  await secondClient.mutation(api.users.ensureCurrent, {});

  await check("a second identity creates a bot and sees it", async () => {
    await secondClient.mutation(api.bots.create, { name: secondBotName });
    const secondBots = await secondClient.query(api.bots.list, {});
    assert.ok(secondBots.some((bot) => bot.name === secondBotName));
  });

  await check("a second identity cannot see the first user's bots", async () => {
    const secondBots = await secondClient.query(api.bots.list, {});
    assert.ok(!secondBots.some((bot) => bot.name === firstBotName));
  });

  await check("the first user cannot see the second identity's bots", async () => {
    const firstBots = await clientA.query(api.bots.list, {});
    assert.ok(firstBots.some((bot) => bot.name === firstBotName));
    assert.ok(!firstBots.some((bot) => bot.name === secondBotName));
    assert.ok(!watchA.updates.flat().some((bot) => bot.name === secondBotName));
  });

  watchA.unsubscribe();

  await check("bots.list with no token is rejected", async () => {
    await assertQueryRejected({ url: convexUrl, token: null, expected: /Not authenticated/ });
  });

  const NO_MATCHING_PROVIDER = /NoAuthProvider/;
  const now = Math.floor(Date.now() / 1000);

  await check("a token signed by a different key with the same kid is rejected", async () => {
    const { privateKey } = await generateKeyPair("ES256");
    await assertQueryRejected({
      url: convexUrl,
      token: await signToken({ subject: SECOND_SUBJECT, key: privateKey }),
      expected: /InvalidAuthHeader.*Could not decode token/,
    });
  });

  await check("a token with a wrong aud is rejected", async () => {
    await assertQueryRejected({
      url: convexUrl,
      token: await signToken({ subject: SECOND_SUBJECT, audience: `${aud}-wrong` }),
      expected: NO_MATCHING_PROVIDER,
    });
  });

  await check("a token with a wrong iss is rejected", async () => {
    await assertQueryRejected({
      url: convexUrl,
      token: await signToken({ subject: SECOND_SUBJECT, issuer: `${iss}-wrong` }),
      expected: NO_MATCHING_PROVIDER,
    });
  });

  await check("an expired token is rejected", async () => {
    await assertQueryRejected({
      url: convexUrl,
      token: await signToken({ subject: SECOND_SUBJECT, issuedAt: now - 7200, expiresAt: now - 3600 }),
      expected: /InvalidAuthHeader.*Token expired/,
    });
  });

  const freshToken = await signToken({ subject: `dev:verify-${runId}@localhost` });
  const tabOne = authenticatedClient({ url: convexUrl, token: freshToken });
  const tabTwo = authenticatedClient({ url: convexUrl, token: freshToken });
  clients.push(tabOne, tabTwo);

  await check("users.current is null before a new identity's first ensureCurrent", async () => {
    assert.equal(await tabOne.query(api.users.current, {}), null);
  });

  await check("users.ensureCurrent run concurrently from two clients yields one row", async () => {
    const results = await Promise.all(
      [tabOne, tabTwo, tabOne, tabTwo].map((tab) => tab.mutation(api.users.ensureCurrent, {})),
    );
    assert.equal(new Set(results.map((user) => user._id)).size, 1);
    const current = await tabOne.query(api.users.current, {});
    assert.equal(current?._id, results[0]?._id);
  });

  await check("users.ensureCurrent run twice in a row keeps the same id", async () => {
    const before = await tabOne.query(api.users.current, {});
    const first = await tabOne.mutation(api.users.ensureCurrent, {});
    const second = await tabTwo.mutation(api.users.ensureCurrent, {});
    assert.ok(before !== null);
    assert.equal(first._id, before._id);
    assert.equal(second._id, before._id);
  });

  await check("bots.create trims the name and rejects empty and overlong names", async () => {
    const trimmed = `verify-trim-${runId}`;
    await tabOne.mutation(api.bots.create, { name: `  ${trimmed}  ` });
    const bots = await tabOne.query(api.bots.list, {});
    assert.ok(bots.some((bot) => bot.name === trimmed));
    await assert.rejects(tabOne.mutation(api.bots.create, { name: "   " }), /empty/);
    await assert.rejects(tabOne.mutation(api.bots.create, { name: "x".repeat(65) }), /longer than 64/);
    await tabOne.mutation(api.bots.create, { name: "x".repeat(64) });
  });

  await check("dev guard allows a plain request", async () => {
    assert.equal((await rawGet({ port, path: "/auth/token" })).status, 200);
  });

  for (const header of ["X-Forwarded-For", "X-Forwarded-Host", "Forwarded", "Tailscale-User-Login"]) {
    await check(`dev guard rejects a request with ${header}`, async () => {
      const response = await rawGet({ port, path: "/auth/token", headers: { [header]: "203.0.113.9" } });
      assert.equal(response.status, 403);
      assert.ok(!response.body.includes('"token"'), "the rejection carried a token");
    });
  }

  await check("dev guard rejects Host: evil.example", async () => {
    const response = await rawGet({ port, path: "/auth/token", headers: { Host: "evil.example" } });
    assert.equal(response.status, 403);
  });

  const indexHtml = readFileSync(resolve(paths.webDist, "index.html"), "utf8");

  for (const path of ["/", "/bots/123"]) {
    await check(`GET ${path} returns index.html`, async () => {
      const response = await rawGet({ port, path });
      assert.equal(response.status, 200);
      assert.equal(response.body, indexHtml);
    });
  }

  for (const path of ["/assets/nope.js", "/auth/nope"]) {
    await check(`GET ${path} returns 404`, async () => {
      const response = await rawGet({ port, path });
      assert.equal(response.status, 404);
      assert.notEqual(response.body, indexHtml);
    });
  }

  const outsideFile = readFileSync(resolve(paths.repoRoot, "package.json"), "utf8");
  const traversals = [
    "/../../package.json",
    "/../../../package.json",
    "/%2e%2e/%2e%2e/%2e%2e/package.json",
    "/%2E%2E/%2E%2E/%2E%2E/package.json",
    "/..%2f..%2f..%2fpackage.json",
    "/%2e%2e%2f%2e%2e%2f%2e%2e%2fpackage.json",
    "/..%5c..%5c..%5cpackage.json",
    "/%252e%252e/%252e%252e/%252e%252e/package.json",
    "/assets/../../../../package.json",
    "/../../../../../../etc/passwd",
    "/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/etc/passwd",
  ];
  for (const path of traversals) {
    await check(`traversal ${path} returns no file outside dist`, async () => {
      const response = await rawGet({ port, path });
      assert.ok(
        response.status === 404 || (response.status === 200 && response.body === indexHtml),
        `got ${response.status}`,
      );
      assert.ok(!response.body.includes(outsideFile));
      assert.ok(!response.body.includes("root:"));
    });
  }

  const lan = lanAddress();
  if (lan === null) {
    console.log("skip  no LAN address on this machine, so loopback binding was not probed");
  } else {
    for (const [name, probePort] of [
      ["orchestrator", port],
      ["Convex backend", 3210],
      ["Convex site proxy", 3211],
      ["Convex dashboard", 6791],
    ] as const) {
      await check(`${name} refuses connections on the LAN address`, async () => {
        assert.ok(await refusesConnection({ host: lan, port: probePort }), `port ${probePort} accepted`);
      });
    }
  }
} catch (error) {
  failures += 1;
  console.log(`FAIL  setup: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await Promise.all(clients.map((client) => client.close()));
  orchestrator.kill();
}

console.log(failures === 0 ? "verify:auth passed" : `verify:auth failed with ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
