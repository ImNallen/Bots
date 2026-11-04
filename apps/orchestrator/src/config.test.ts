import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.ts";

const SECRET_D = "c2VjcmV0LXNjYWxhci12YWx1ZQ";

const privateJwk = {
  kty: "EC",
  crv: "P-256",
  kid: "test-kid",
  x: "eA",
  y: "eQ",
  d: SECRET_D,
};

const MASTER_KEY = Buffer.alloc(32, 7).toString("base64");

const validEnv = {
  AUTH_MODE: "dev",
  JWT_ISSUER: "https://orchestrator.bots.localhost",
  JWT_PRIVATE_JWK: JSON.stringify(privateJwk),
  MASTER_KEY,
  CONVEX_URL: "http://127.0.0.1:3210",
  COMPUTER_TOKEN: "computer-token",
};

describe("parseConfig", () => {
  it("parses a dev configuration with defaults", () => {
    const config = parseConfig(validEnv);
    expect(config.authMode).toEqual({ kind: "dev", login: "dev@localhost", computerToken: "computer-token" });
    expect(config.port).toBe(8787);
    expect(config.link).toEqual({ host: "127.0.0.1", port: 8788 });
    expect(config.computerWaitMs).toBe(300_000);
    expect(config.mistral).toEqual({ baseUrl: "https://api.mistral.ai", model: "mistral-large-4" });
    expect(config.masterKey).toEqual(Buffer.alloc(32, 7));
    expect(config.issuer).toBe("https://orchestrator.bots.localhost");
    expect(config.signingKey.kid).toBe("test-kid");
    expect(config.signingKey.jwk.d).toBe(SECRET_D);
    expect(config.webDistDir).toMatch(/apps\/web\/dist$/);
  });

  it("reads the dev login and the port", () => {
    const config = parseConfig({ ...validEnv, DEV_LOGIN: "other@localhost", PORT: "9000" });
    expect(config.authMode).toMatchObject({ kind: "dev", login: "other@localhost" });
    expect(config.port).toBe(9000);
  });

  it("reads the link host and port and the Mistral settings, and trims a trailing slash", () => {
    const config = parseConfig({
      ...validEnv,
      LINK_HOST: "10.0.0.1",
      LINK_PORT: "9001",
      MISTRAL_BASE_URL: "http://127.0.0.1:9/",
      MISTRAL_MODEL: "other-model",
    });
    expect(config.link).toEqual({ host: "10.0.0.1", port: 9001 });
    expect(config.mistral).toEqual({ baseUrl: "http://127.0.0.1:9", model: "other-model" });
  });

  it("parses tailscale mode, ignores DEV_LOGIN, and needs no computer token", () => {
    const config = parseConfig({
      ...validEnv,
      AUTH_MODE: "tailscale",
      DEV_LOGIN: "x@localhost",
      COMPUTER_TOKEN: undefined,
    });
    expect(config.authMode).toEqual({ kind: "tailscale" });
  });

  it.each(["AUTH_MODE", "JWT_ISSUER", "JWT_PRIVATE_JWK", "MASTER_KEY", "CONVEX_URL", "COMPUTER_TOKEN"])("requires %s", (name) => {
    expect(() => parseConfig({ ...validEnv, [name]: undefined })).toThrow(name);
    expect(() => parseConfig({ ...validEnv, [name]: "" })).toThrow(name);
  });

  it("rejects an unknown AUTH_MODE", () => {
    expect(() => parseConfig({ ...validEnv, AUTH_MODE: "none" })).toThrow("AUTH_MODE");
  });

  it.each(["0", "65536", "80.5", "http", "-1"])("rejects PORT %s", (port) => {
    expect(() => parseConfig({ ...validEnv, PORT: port })).toThrow("PORT");
  });

  it.each(["0", "65536", "http"])("rejects LINK_PORT %s", (port) => {
    expect(() => parseConfig({ ...validEnv, LINK_PORT: port })).toThrow("LINK_PORT");
  });

  it.each([
    ["too short", Buffer.alloc(16).toString("base64")],
    ["too long", Buffer.alloc(33).toString("base64")],
    ["not base64", "not base64 at all!!"],
  ])("rejects a MASTER_KEY that is %s without echoing it", (_label, value) => {
    let message = "";
    try {
      parseConfig({ ...validEnv, MASTER_KEY: value });
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).toContain("MASTER_KEY");
    expect(message).not.toContain(value);
  });

  it("rejects an issuer that is not a URL", () => {
    expect(() => parseConfig({ ...validEnv, JWT_ISSUER: "not a url" })).toThrow("JWT_ISSUER");
  });

  it.each([
    ["a public key", { ...privateJwk, d: undefined }],
    ["no kid", { ...privateJwk, kid: undefined }],
    ["another curve", { ...privateJwk, crv: "P-384" }],
    ["another key type", { ...privateJwk, kty: "RSA" }],
    ["no coordinates", { ...privateJwk, x: undefined }],
  ])("rejects a JWK with %s", (_label, jwk) => {
    expect(() => parseConfig({ ...validEnv, JWT_PRIVATE_JWK: JSON.stringify(jwk) })).toThrow(
      "JWT_PRIVATE_JWK",
    );
  });

  it.each(["null", "3"])("rejects JWT_PRIVATE_JWK that is the JSON value %s", (raw) => {
    expect(() => parseConfig({ ...validEnv, JWT_PRIVATE_JWK: raw })).toThrow("JWT_PRIVATE_JWK");
  });

  it("does not echo a malformed key in the error", () => {
    const malformed = `{"d":"${SECRET_D}"`;
    expect(() => parseConfig({ ...validEnv, JWT_PRIVATE_JWK: malformed })).toThrow(
      /^JWT_PRIVATE_JWK is not valid JSON$/,
    );
  });
});
