import { fileURLToPath } from "node:url";
import type { JWK } from "jose";
import type { AuthMode } from "./auth.ts";

export type Config = {
  authMode: AuthMode;
  port: number;
  issuer: string;
  signingKey: { kid: string; jwk: JWK };
  webDistDir: string;
};

const DEFAULT_PORT = 8787;
const DEFAULT_DEV_LOGIN = "dev@localhost";
const WEB_DIST_DIR = fileURLToPath(new URL("../../web/dist", import.meta.url));

type Env = Record<string, string | undefined>;

function required(args: { env: Env; name: string }): string {
  const value = args.env[args.name];
  if (value === undefined || value === "") {
    throw new Error(`${args.name} is required`);
  }
  return value;
}

function parseAuthMode(env: Env): AuthMode {
  const mode = required({ env, name: "AUTH_MODE" });
  switch (mode) {
    case "tailscale":
      return { kind: "tailscale" };
    case "dev":
      return { kind: "dev", login: env.DEV_LOGIN || DEFAULT_DEV_LOGIN };
    default:
      throw new Error(`AUTH_MODE must be "tailscale" or "dev", got "${mode}"`);
  }
}

function parsePort(env: Env): number {
  const raw = env.PORT;
  if (raw === undefined || raw === "") {
    return DEFAULT_PORT;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer from 1 to 65535, got "${raw}"`);
  }
  return port;
}

function parseIssuer(env: Env): string {
  const issuer = required({ env, name: "JWT_ISSUER" });
  if (!URL.canParse(issuer)) {
    throw new Error(`JWT_ISSUER must be a URL, got "${issuer}"`);
  }
  return issuer;
}

// Errors here name the variable and never echo its value, because the value is a private key.
function parseSigningKey(env: Env): Config["signingKey"] {
  const raw = required({ env, name: "JWT_PRIVATE_JWK" });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("JWT_PRIVATE_JWK is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("JWT_PRIVATE_JWK must be a JSON object");
  }
  const { kty, crv, x, y, d, kid } = parsed as Record<string, unknown>;
  if (kty !== "EC" || crv !== "P-256") {
    throw new Error("JWT_PRIVATE_JWK must be a P-256 EC key");
  }
  if (typeof d !== "string" || d === "") {
    throw new Error("JWT_PRIVATE_JWK must be a private key, and d is missing");
  }
  if (typeof kid !== "string" || kid === "") {
    throw new Error("JWT_PRIVATE_JWK must have a kid");
  }
  if (typeof x !== "string" || typeof y !== "string") {
    throw new Error("JWT_PRIVATE_JWK must have x and y coordinates");
  }
  return { kid, jwk: { kty, crv, x, y, d, kid } };
}

export function parseConfig(env: Env): Config {
  return {
    authMode: parseAuthMode(env),
    port: parsePort(env),
    issuer: parseIssuer(env),
    signingKey: parseSigningKey(env),
    webDistDir: WEB_DIST_DIR,
  };
}
