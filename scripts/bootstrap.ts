import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { calculateJwkThumbprint, exportJWK, generateKeyPair } from "jose";
import {
  parseConvexEnvList,
  parsePrivateJwk,
  paths,
  readEnvFile,
  runCommand,
  runConvex,
  type CommandResult,
  type PrivateJwk,
} from "./lib.ts";

const CONVEX_URL = "http://127.0.0.1:3210";
const DEFAULT_ISSUER = "https://orchestrator.bots.localhost";
const DEFAULT_DEV_LOGIN = "dev@localhost";
const DEFAULT_PORT = "8787";
const DEFAULT_LINK_PORT = "8788";

function report(args: { step: string; outcome: string }): void {
  console.log(`${args.step}: ${args.outcome}`);
}

function requireOk(args: { step: string; result: CommandResult }): string {
  if (args.result.kind === "failed") {
    throw new Error(`${args.step} failed:\n${args.result.output}`);
  }
  return args.result.stdout;
}

// A kill before the rename leaves only the gitignored temp file, which the next run overwrites.
function writeEnvFile(args: { path: string; content: string }): void {
  const temp = `${args.path}.tmp`;
  writeFileSync(temp, args.content, { mode: 0o600 });
  renameSync(temp, args.path);
}

function addMissingEnvValues(args: { path: string; missing: Record<string, string> }): void {
  const existing = existsSync(args.path) ? readFileSync(args.path, "utf8") : "";
  const added = Object.entries(args.missing).map(([key, value]) => `${key}='${value}'\n`);
  writeEnvFile({ path: args.path, content: existing + added.join("") });
}

async function generatePrivateJwk(): Promise<PrivateJwk> {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const jwk = await exportJWK(privateKey);
  const kid = await calculateJwkThumbprint(jwk);
  return parsePrivateJwk(JSON.stringify({ ...jwk, kid }));
}

type RootEnv = { privateJwk: PrivateJwk; issuer: string; computerToken: string; linkPort: string; searxngSecret: string };

async function ensureRootEnv(): Promise<RootEnv> {
  const existing = readEnvFile(paths.rootEnv);
  const missing: Record<string, string> = {};
  const defaults = {
    AUTH_MODE: "dev",
    DEV_LOGIN: DEFAULT_DEV_LOGIN,
    PORT: DEFAULT_PORT,
    LINK_PORT: DEFAULT_LINK_PORT,
    JWT_ISSUER: DEFAULT_ISSUER,
    CONVEX_URL,
  };
  for (const [key, value] of Object.entries(defaults)) {
    if (existing[key] === undefined) {
      missing[key] = value;
    }
  }
  const privateJwk =
    existing.JWT_PRIVATE_JWK === undefined
      ? await generatePrivateJwk()
      : parsePrivateJwk(existing.JWT_PRIVATE_JWK);
  if (existing.JWT_PRIVATE_JWK === undefined) {
    missing.JWT_PRIVATE_JWK = JSON.stringify(privateJwk);
  }
  // Rotating MASTER_KEY would orphan every stored key, so this only ever adds a missing one.
  if (existing.MASTER_KEY === undefined) {
    missing.MASTER_KEY = randomBytes(32).toString("base64");
  }
  const computerToken = existing.COMPUTER_TOKEN ?? randomBytes(32).toString("base64url");
  if (existing.COMPUTER_TOKEN === undefined) {
    missing.COMPUTER_TOKEN = computerToken;
  }
  const searxngSecret = existing.SEARXNG_SECRET ?? randomBytes(32).toString("base64url");
  if (existing.SEARXNG_SECRET === undefined) {
    missing.SEARXNG_SECRET = searxngSecret;
  }
  const added = Object.keys(missing);
  if (added.length > 0) {
    addMissingEnvValues({ path: paths.rootEnv, missing });
  }
  report({
    step: ".env.local",
    outcome: added.length > 0 ? `added ${added.join(", ")}` : "unchanged",
  });
  return {
    privateJwk,
    issuer: existing.JWT_ISSUER ?? DEFAULT_ISSUER,
    computerToken,
    linkPort: existing.LINK_PORT ?? DEFAULT_LINK_PORT,
    searxngSecret,
  };
}

function ensureWebEnv(): void {
  if (readEnvFile(paths.webEnv).VITE_CONVEX_URL !== undefined) {
    report({ step: "apps/web/.env.local", outcome: "unchanged" });
    return;
  }
  addMissingEnvValues({ path: paths.webEnv, missing: { VITE_CONVEX_URL: CONVEX_URL } });
  report({ step: "apps/web/.env.local", outcome: "added VITE_CONVEX_URL" });
}

function controlCompose(args: { step: string; argv: string[]; searxngSecret: string }): string {
  return requireOk({
    step: args.step,
    result: runCommand({
      command: "docker",
      argv: ["compose", ...args.argv],
      cwd: paths.composeDir,
      env: { SEARXNG_SECRET: args.searxngSecret },
    }),
  });
}

function startContainers(searxngSecret: string): void {
  controlCompose({ step: "docker compose up", argv: ["up", "--detach", "--wait"], searxngSecret });
  report({ step: "containers", outcome: "healthy" });
}

function generateAdminKey(searxngSecret: string): string {
  const stdout = controlCompose({ step: "generate_admin_key.sh", argv: ["exec", "-T", "backend", "./generate_admin_key.sh"], searxngSecret });
  const key = stdout.trim().split("\n").at(-1);
  if (key === undefined || !key.includes("|")) {
    throw new Error("generate_admin_key.sh did not print an admin key");
  }
  return key;
}

function adminKeyIsAccepted(): boolean {
  const result = runConvex(["env", "list"]);
  if (result.kind === "ok") {
    return true;
  }
  if (/admin key was invalid/i.test(result.output)) {
    return false;
  }
  throw new Error(`convex env list failed:\n${result.output}`);
}

function ensureAdminKey(searxngSecret: string): void {
  const existing = readEnvFile(paths.convexEnv);
  if (existing.CONVEX_SELF_HOSTED_ADMIN_KEY !== undefined && adminKeyIsAccepted()) {
    report({ step: "packages/convex/.env.local", outcome: "unchanged" });
    return;
  }
  // A key the backend refuses belongs to a deleted volume, so replacing it rotates nothing.
  writeEnvFile({
    path: paths.convexEnv,
    content: `CONVEX_SELF_HOSTED_URL='${CONVEX_URL}'\nCONVEX_SELF_HOSTED_ADMIN_KEY='${generateAdminKey(searxngSecret)}'\n`,
  });
  report({ step: "packages/convex/.env.local", outcome: "wrote a new admin key" });
}

function jwksDataUri(privateJwk: PrivateJwk): string {
  const { d: _private, ...publicJwk } = privateJwk;
  const encoded = Buffer.from(JSON.stringify({ keys: [publicJwk] })).toString("base64");
  return `data:text/plain;charset=utf-8;base64,${encoded}`;
}

function ensureConvexEnv(args: { privateJwk: PrivateJwk; issuer: string }): void {
  const current = parseConvexEnvList(
    requireOk({ step: "convex env list", result: runConvex(["env", "list", "--include-values"]) }),
  );
  const desired = { JWT_ISSUER: args.issuer, JWT_JWKS: jwksDataUri(args.privateJwk) };
  for (const [name, value] of Object.entries(desired)) {
    if (current.get(name) === value) {
      report({ step: `convex env ${name}`, outcome: "unchanged" });
      continue;
    }
    requireOk({ step: `convex env set ${name}`, result: runConvex(["env", "set", name, value]) });
    report({ step: `convex env ${name}`, outcome: "set" });
  }
}

function deployFunctions(): void {
  requireOk({ step: "convex deploy", result: runConvex(["deploy", "--yes"]) });
  report({ step: "convex functions", outcome: "deployed" });
}

function startComputer(args: { computerToken: string; linkPort: string }): void {
  const compose = (step: string, argv: string[]): string =>
    requireOk({
      step,
      result: runCommand({
        command: "docker",
        argv: ["compose", ...argv],
        cwd: paths.computerdComposeDir,
        env: {
          COMPUTER_TOKEN: args.computerToken,
          COMPUTER_LINK_URL: `ws://host.docker.internal:${args.linkPort}`,
        },
      }),
    });
  const namespaceOf = (service: string): string =>
    compose(`read the ${service} namespace`, ["exec", "-T", service, "readlink", "/proc/self/ns/net"]);

  compose("docker compose up computerd", ["up", "--detach", "--build", "--wait"]);
  // A restarted netguard gets a new namespace. A running computerd stays in the old one, which has no network, and up leaves it there.
  if (namespaceOf("computerd") !== namespaceOf("netguard")) {
    compose("docker compose restart computerd", ["restart", "computerd"]);
    report({ step: "computerd", outcome: "restarted to join netguard's namespace" });
    return;
  }
  report({ step: "computerd", outcome: "running behind netguard" });
}

const { privateJwk, issuer, computerToken, linkPort, searxngSecret } = await ensureRootEnv();
ensureWebEnv();
startContainers(searxngSecret);
ensureAdminKey(searxngSecret);
ensureConvexEnv({ privateJwk, issuer });
deployFunctions();
// In Tailscale mode, users' computers are VMs, not this machine's containers.
if ((readEnvFile(paths.rootEnv).AUTH_MODE ?? "dev") === "dev") {
  startComputer({ computerToken, linkPort });
}
