import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { SignJWT, importJWK } from "jose";
import { resolveIdentity, type Identity, type RejectionReason } from "./auth.ts";
import { parseConfig } from "./config.ts";
import { loadStaticFiles, resolveStaticFile } from "./static.ts";

// tailscale serve is the only thing able to reach this socket, which is what makes its identity header unforgeable.
const HOST = "127.0.0.1";
// Convex checks this against applicationID in packages/convex/convex/auth.config.ts.
const AUDIENCE = "bots";
const TOKEN_TTL_SECONDS = 60 * 60;

const REJECTION_STATUS = {
  "missing-tailscale-login": 401,
  "proxied-request": 403,
  "non-loopback-host": 403,
} as const satisfies Record<RejectionReason, number>;

function log(args: { level: "info" | "warn"; event: string; [field: string]: unknown }): void {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), ...args })}\n`);
}

const config = parseConfig(process.env);
const signingKey = await importJWK(config.signingKey.jwk, "ES256");
const staticFiles = await loadStaticFiles({ distDir: config.webDistDir });

if (staticFiles.size === 0) {
  log({ level: "warn", event: "web-dist-empty", webDistDir: config.webDistDir });
}

async function issueToken(identity: Identity): Promise<{ token: string; expiresAt: number }> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + TOKEN_TTL_SECONDS;
  const token = await new SignJWT({ email: identity.email, name: identity.displayName })
    .setProtectedHeader({ alg: "ES256", kid: config.signingKey.kid, typ: "JWT" })
    .setSubject(identity.subject)
    .setIssuer(config.issuer)
    .setAudience(AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(signingKey);
  return { token, expiresAt };
}

const app = new Hono();

app.get("/healthz", (c) => c.json({ status: "ok" }));

app.get("/auth/token", async (c) => {
  c.header("Cache-Control", "no-store");
  const result = resolveIdentity({ mode: config.authMode, headers: c.req.raw.headers });
  switch (result.kind) {
    case "ok": {
      log({ level: "info", event: "token-issued", subject: result.identity.subject });
      return c.json(await issueToken(result.identity));
    }
    case "rejected": {
      log({ level: "warn", event: "token-rejected", reason: result.reason });
      return c.json({ error: result.reason }, REJECTION_STATUS[result.reason]);
    }
  }
});

app.all("/auth/*", (c) => c.json({ error: "not-found" }, 404));

app.get("*", (c) => {
  const file = resolveStaticFile({ files: staticFiles, pathname: new URL(c.req.url).pathname });
  if (file === null) {
    return c.json({ error: "not-found" }, 404);
  }
  return c.body(file.body, 200, {
    "Content-Type": file.contentType,
    "Cache-Control": file.cacheControl,
  });
});

serve({ fetch: app.fetch, hostname: HOST, port: config.port }, ({ port }) => {
  log({ level: "info", event: "listening", host: HOST, port, authMode: config.authMode.kind });
});
