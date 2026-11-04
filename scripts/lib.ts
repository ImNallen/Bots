import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

export const paths = {
  repoRoot,
  rootEnv: resolve(repoRoot, ".env.local"),
  webEnv: resolve(repoRoot, "apps/web/.env.local"),
  convexEnv: resolve(repoRoot, "packages/convex/.env.local"),
  composeDir: resolve(repoRoot, "infra/control-vm"),
  computerdComposeDir: resolve(repoRoot, "apps/computerd"),
  convexDir: resolve(repoRoot, "packages/convex"),
  convexBin: resolve(repoRoot, "packages/convex/node_modules/.bin/convex"),
  orchestratorMain: resolve(repoRoot, "apps/orchestrator/src/main.ts"),
  webDist: resolve(repoRoot, "apps/web/dist"),
};

export function readEnvFile(path: string): Record<string, string | undefined> {
  try {
    return parseEnv(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

export type CommandResult =
  | { kind: "ok"; stdout: string }
  | { kind: "failed"; output: string };

export function runCommand(args: {
  command: string;
  argv: string[];
  cwd: string;
  env?: Record<string, string>;
}): CommandResult {
  const result = spawnSync(args.command, args.argv, {
    cwd: args.cwd,
    encoding: "utf8",
    env: { ...process.env, ...args.env },
  });
  if (result.error !== undefined) {
    return { kind: "failed", output: result.error.message };
  }
  if (result.status !== 0) {
    return { kind: "failed", output: `${result.stdout}${result.stderr}` };
  }
  return { kind: "ok", stdout: result.stdout };
}

export function runConvex(argv: string[]): CommandResult {
  return runCommand({ command: paths.convexBin, argv, cwd: paths.convexDir });
}

export type ConvexEnv = Map<string, string>;

export function parseConvexEnvList(stdout: string): ConvexEnv {
  const entries = stdout
    .split("\n")
    .map((line) => {
      const separator = line.indexOf("=");
      return separator === -1 ? null : ([line.slice(0, separator), line.slice(separator + 1)] as const);
    })
    .filter((entry) => entry !== null);
  return new Map(entries);
}

export type PrivateJwk = {
  kty: "EC";
  crv: "P-256";
  alg: "ES256";
  use: "sig";
  kid: string;
  x: string;
  y: string;
  d: string;
};

export function parsePrivateJwk(raw: string): PrivateJwk {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("JWT_PRIVATE_JWK is not a JSON object");
  }
  const { kid, x, y, d, kty, crv } = parsed as Record<string, unknown>;
  if (
    kty !== "EC" ||
    crv !== "P-256" ||
    typeof kid !== "string" ||
    typeof x !== "string" ||
    typeof y !== "string" ||
    typeof d !== "string"
  ) {
    throw new Error("JWT_PRIVATE_JWK is not a private P-256 JWK with a kid");
  }
  return { kty, crv, alg: "ES256", use: "sig", kid, x, y, d };
}
