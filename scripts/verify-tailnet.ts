import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createConnection } from "node:net";
import { api } from "@bots/convex";
import { ConvexClient, ConvexHttpClient } from "convex/browser";
import { decodeJwt } from "jose";

const CONVEX_PORT = 8443;
const LIVE_UPDATE_TIMEOUT_MS = 15_000;
const CONNECT_TIMEOUT_MS = 3000;
const PRIVATE_PORTS = [8787, 8788, 3210, 3211, 6791];

const [origin, lanAddress] = process.argv.slice(2);
if (origin === undefined || !URL.canParse(origin)) {
  console.error("usage: pnpm verify:tailnet https://<machine>.<tailnet>.ts.net [LAN address]");
  process.exit(2);
}
const convexUrl = `https://${new URL(origin).hostname}:${CONVEX_PORT}`;

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

async function fetchToken(headers: Record<string, string> = {}): Promise<{ token: string; subject: string }> {
  const response = await fetch(`${origin}/auth/token`, { headers });
  assert.equal(response.status, 200, `GET /auth/token returned ${response.status}`);
  const body: unknown = await response.json();
  assert.ok(typeof body === "object" && body !== null && "token" in body && typeof body.token === "string");
  const { sub } = decodeJwt(body.token);
  assert.ok(sub !== undefined, "the token has no subject");
  return { token: body.token, subject: sub };
}

function portAnswers(args: { host: string; port: number }): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: args.host, port: args.port, timeout: CONNECT_TIMEOUT_MS });
    const finish = (answered: boolean) => {
      socket.destroy();
      resolve(answered);
    };
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

await check("the web app answers over HTTPS with a valid certificate", async () => {
  const response = await fetch(`${origin}/healthz`);
  assert.equal(response.status, 200);
});

const { token, subject } = await fetchToken();
await check(`Tailscale identifies this device's user as ${subject}`, () => {
  assert.match(subject, /^tailscale:.+/);
});

await check("a forged identity header does not change who the token is for", async () => {
  const forged = await fetchToken({ "Tailscale-User-Login": "attacker@example.com" });
  assert.equal(forged.subject, subject);
});

await check("a page route returns the web app and a missing asset returns 404", async () => {
  const page = await fetch(`${origin}/bots/123`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  assert.equal((await fetch(`${origin}/assets/nope.js`)).status, 404);
});

await check("Convex refuses a query with no token", async () => {
  await assert.rejects(new ConvexHttpClient(convexUrl).query(api.bots.list, {}), /Not authenticated/);
});

await check("a live query updates over a WebSocket through tailscale serve", async () => {
  const name = `verify-tailnet-${randomBytes(4).toString("hex")}`;
  const http = new ConvexHttpClient(convexUrl);
  http.setAuth(token);
  await http.mutation(api.users.ensureCurrent, {});
  const live = new ConvexClient(convexUrl, { logger: false });
  live.setAuth(async () => token);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no live update arrived")), LIVE_UPDATE_TIMEOUT_MS);
      let created = false;
      live.onUpdate(api.bots.list, {}, (bots) => {
        if (!created) {
          created = true;
          http.mutation(api.bots.create, { name }).catch(reject);
        }
        if (bots.some((bot) => bot.name === name)) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
  } finally {
    await live.close();
  }
});

if (lanAddress !== undefined) {
  for (const port of PRIVATE_PORTS) {
    await check(`port ${port} does not answer on the LAN address`, async () => {
      assert.equal(await portAnswers({ host: lanAddress, port }), false);
    });
  }
}

console.log(failures === 0 ? "verify:tailnet passed" : `verify:tailnet failed with ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
