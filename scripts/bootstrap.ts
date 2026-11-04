import { appendFileSync, copyFileSync, existsSync, renameSync, writeFileSync } from "node:fs";
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

function report(args: { step: string; outcome: string }): void {
  console.log(`${args.step}: ${args.outcome}`);
}

function requireOk(args: { step: string; result: CommandResult }): string {
  if (args.result.kind === "failed") {
    throw new Error(`${args.step} failed:\n${args.result.output}`);
  }
  return args.result.stdout;
}

// A kill between the copy and the rename leaves only the gitignored temp file, which the next run overwrites.
function addMissingEnvValues(args: {
  path: string;
  missing: Record<string, string>;
}): void {
  const temp = `${args.path}.tmp`;
  if (existsSync(args.path)) {
    copyFileSync(args.path, temp);
  } else {
    writeFileSync(temp, "");
  }
  const lines = Object.entries(args.missing).map(([key, value]) => `${key}='${value}'\n`);
  appendFileSync(temp, lines.join(""), { mode: 0o600 });
  renameSync(temp, args.path);
}

async function generatePrivateJwk(): Promise<PrivateJwk> {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const jwk = await exportJWK(privateKey);
  const kid = await calculateJwkThumbprint(jwk);
  return parsePrivateJwk(JSON.stringify({ ...jwk, kid }));
}

async function ensureRootEnv(): Promise<{ privateJwk: PrivateJwk; issuer: string }> {
  const existing = readEnvFile(paths.rootEnv);
  const missing: Record<string, string> = {};
  const defaults = {
    AUTH_MODE: "dev",
    DEV_LOGIN: DEFAULT_DEV_LOGIN,
    PORT: DEFAULT_PORT,
    JWT_ISSUER: DEFAULT_ISSUER,
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
  const added = Object.keys(missing);
  if (added.length > 0) {
    addMissingEnvValues({ path: paths.rootEnv, missing });
  }
  report({
    step: ".env.local",
    outcome: added.length > 0 ? `added ${added.join(", ")}` : "unchanged",
  });
  return { privateJwk, issuer: existing.JWT_ISSUER ?? DEFAULT_ISSUER };
}

function ensureWebEnv(): void {
  if (readEnvFile(paths.webEnv).VITE_CONVEX_URL !== undefined) {
    report({ step: "apps/web/.env.local", outcome: "unchanged" });
    return;
  }
  addMissingEnvValues({ path: paths.webEnv, missing: { VITE_CONVEX_URL: CONVEX_URL } });
  report({ step: "apps/web/.env.local", outcome: "added VITE_CONVEX_URL" });
}

function startContainers(): void {
  requireOk({
    step: "docker compose up",
    result: runCommand({
      command: "docker",
      argv: ["compose", "up", "--detach", "--wait"],
      cwd: paths.composeDir,
    }),
  });
  report({ step: "containers", outcome: "healthy" });
}

function generateAdminKey(): string {
  const stdout = requireOk({
    step: "generate_admin_key.sh",
    result: runCommand({
      command: "docker",
      argv: ["compose", "exec", "-T", "backend", "./generate_admin_key.sh"],
      cwd: paths.composeDir,
    }),
  });
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

function ensureAdminKey(): void {
  const existing = readEnvFile(paths.convexEnv);
  if (existing.CONVEX_SELF_HOSTED_ADMIN_KEY !== undefined && adminKeyIsAccepted()) {
    report({ step: "packages/convex/.env.local", outcome: "unchanged" });
    return;
  }
  // A key the backend refuses belongs to a deleted volume, so replacing it rotates nothing.
  const content = `CONVEX_SELF_HOSTED_URL='${CONVEX_URL}'\nCONVEX_SELF_HOSTED_ADMIN_KEY='${generateAdminKey()}'\n`;
  const temp = `${paths.convexEnv}.tmp`;
  writeFileSync(temp, content, { mode: 0o600 });
  renameSync(temp, paths.convexEnv);
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

const { privateJwk, issuer } = await ensureRootEnv();
ensureWebEnv();
startContainers();
ensureAdminKey();
ensureConvexEnv({ privateJwk, issuer });
deployFunctions();
