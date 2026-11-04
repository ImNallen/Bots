import { fileURLToPath } from "node:url";
import type { JWK } from "jose";
import type { AuthMode } from "./auth.ts";

export type Config = {
  authMode: AuthMode;
  port: number;
  link: { host: string; port: number };
  computerWaitMs: number;
  issuer: string;
  signingKey: { kid: string; jwk: JWK };
  masterKey: Buffer;
  convexUrl: string;
  mistral: { baseUrl: string; model: string };
  webDistDir: string;
};

const DEFAULT_PORT = 8787;
const DEFAULT_LINK_HOST = "127.0.0.1";
const DEFAULT_LINK_PORT = 8788;
const DEFAULT_COMPUTER_WAIT_SECONDS = 5 * 60;
const DEFAULT_MISTRAL_BASE_URL = "https://api.mistral.ai";
const DEFAULT_MISTRAL_MODEL = "mistral-large-4";
const MASTER_KEY_BYTES = 32;
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
      return {
        kind: "dev",
        login: env.DEV_LOGIN || DEFAULT_DEV_LOGIN,
        computerToken: required({ env, name: "COMPUTER_TOKEN" }),
      };
    default:
      throw new Error(`AUTH_MODE must be "tailscale" or "dev", got "${mode}"`);
  }
}

function parsePort(args: { env: Env; name: string; fallback: number }): number {
  const raw = args.env[args.name];
  if (raw === undefined || raw === "") {
    return args.fallback;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${args.name} must be an integer from 1 to 65535, got "${raw}"`);
  }
  return port;
}

function parseComputerWaitMs(env: Env): number {
  const raw = env.COMPUTER_WAIT_SECONDS;
  if (raw === undefined || raw === "") {
    return DEFAULT_COMPUTER_WAIT_SECONDS * 1000;
  }
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`COMPUTER_WAIT_SECONDS must be a positive number, got "${raw}"`);
  }
  return seconds * 1000;
}

function parseUrl(args: { value: string; name: string }): string {
  if (!URL.canParse(args.value)) {
    throw new Error(`${args.name} must be a URL, got "${args.value}"`);
  }
  return args.value.replace(/\/+$/, "");
}

function parseIssuer(env: Env): string {
  const issuer = required({ env, name: "JWT_ISSUER" });
  if (!URL.canParse(issuer)) {
    throw new Error(`JWT_ISSUER must be a URL, got "${issuer}"`);
  }
  return issuer;
}

function parseMasterKey(env: Env): Buffer {
  const raw = required({ env, name: "MASTER_KEY" });
  const key = Buffer.from(raw, "base64");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw) || key.length !== MASTER_KEY_BYTES) {
    throw new Error(`MASTER_KEY must be ${MASTER_KEY_BYTES} bytes of base64. Run pnpm bootstrap to generate one.`);
  }
  return key;
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
    port: parsePort({ env, name: "PORT", fallback: DEFAULT_PORT }),
    link: {
      host: env.LINK_HOST || DEFAULT_LINK_HOST,
      port: parsePort({ env, name: "LINK_PORT", fallback: DEFAULT_LINK_PORT }),
    },
    computerWaitMs: parseComputerWaitMs(env),
    issuer: parseIssuer(env),
    signingKey: parseSigningKey(env),
    masterKey: parseMasterKey(env),
    convexUrl: parseUrl({ value: required({ env, name: "CONVEX_URL" }), name: "CONVEX_URL" }),
    mistral: {
      baseUrl: parseUrl({ value: env.MISTRAL_BASE_URL || DEFAULT_MISTRAL_BASE_URL, name: "MISTRAL_BASE_URL" }),
      model: env.MISTRAL_MODEL || DEFAULT_MISTRAL_MODEL,
    },
    webDistDir: WEB_DIST_DIR,
  };
}
