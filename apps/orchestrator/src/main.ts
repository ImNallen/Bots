import { api } from "@bots/convex";
import type { Id } from "@bots/convex/dataModel";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { REJECTION_STATUS, identityFor, resolveIdentity } from "./auth.ts";
import { parseConfig } from "./config.ts";
import { keyRoutes } from "./keys.ts";
import { startLink } from "./link.ts";
import { log } from "./log.ts";
import { createProxmox } from "./proxmox.ts";
import { startReconciler } from "./reconciler.ts";
import { startRunner } from "./runner.ts";
import { hashComputerToken } from "./secrets.ts";
import { createService } from "./service.ts";
import { loadStaticFiles, resolveStaticFile } from "./static.ts";
import { createTokenIssuer } from "./tokens.ts";

// tailscale serve is the only thing able to reach this socket, which is what makes its identity header unforgeable.
const HOST = "127.0.0.1";

const config = parseConfig(process.env);
const issuer = await createTokenIssuer(config);
const service = createService({ url: config.convexUrl, issuer });
const staticFiles = await loadStaticFiles({ distDir: config.webDistDir });

if (staticFiles.size === 0) {
  log({ level: "warn", event: "web-dist-empty", webDistDir: config.webDistDir });
}

// A dev orchestrator serves one login, so it leaves every other owner's runs to whichever process serves that owner.
async function registerDevComputer(): Promise<Id<"users"> | undefined> {
  if (config.authMode.kind !== "dev") {
    return undefined;
  }
  const identity = identityFor({ provider: "dev", login: config.authMode.login });
  const { ownerId } = await service.mutation(api.computers.register, {
    ownerSubject: identity.subject,
    email: identity.email,
    displayName: identity.displayName,
    tokenHash: hashComputerToken(config.authMode.computerToken),
  });
  return ownerId;
}

const ownerScope = await registerDevComputer();

const link = startLink({
  ...config.link,
  computerWaitMs: config.computerWaitMs,
  authenticate: (token) => service.query(api.computers.byTokenHash, { tokenHash: hashComputerToken(token) }),
  log,
});

startRunner({ service, link, masterKey: config.masterKey, mistral: config.mistral, ownerScope, log });

if (config.proxmox !== null) {
  const { url, node, token, caFile } = config.proxmox;
  startReconciler({
    service,
    link,
    proxmox: createProxmox({ url, node, token, caPem: await readFile(caFile, "utf8") }),
    linkUrl: `ws://${config.link.host}:${config.link.port}`,
    log,
  });
}

const app = new Hono();

app.get("/healthz", (c) => c.json({ status: "ok" }));

app.get("/auth/token", async (c) => {
  c.header("Cache-Control", "no-store");
  const result = resolveIdentity({ mode: config.authMode, headers: c.req.raw.headers });
  switch (result.kind) {
    case "ok": {
      log({ level: "info", event: "token-issued", subject: result.identity.subject });
      return c.json(await issuer.forUser(result.identity));
    }
    case "rejected": {
      log({ level: "warn", event: "token-rejected", reason: result.reason });
      return c.json({ error: result.reason }, REJECTION_STATUS[result.reason]);
    }
  }
});

app.all("/auth/*", (c) => c.json({ error: "not-found" }, 404));

app.route(
  "/api/mistral-key",
  keyRoutes({
    authMode: config.authMode,
    masterKey: config.masterKey,
    mistralBaseUrl: config.mistral.baseUrl,
    service,
    log,
  }),
);

app.all("/api/*", (c) => c.json({ error: "not-found" }, 404));

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
