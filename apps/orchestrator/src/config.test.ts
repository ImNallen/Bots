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

const validEnv = {
  AUTH_MODE: "dev",
  JWT_ISSUER: "https://orchestrator.bots.localhost",
  JWT_PRIVATE_JWK: JSON.stringify(privateJwk),
};

describe("parseConfig", () => {
  it("parses a dev configuration with defaults", () => {
    const config = parseConfig(validEnv);
    expect(config.authMode).toEqual({ kind: "dev", login: "dev@localhost" });
    expect(config.port).toBe(8787);
    expect(config.issuer).toBe("https://orchestrator.bots.localhost");
    expect(config.signingKey.kid).toBe("test-kid");
    expect(config.signingKey.jwk.d).toBe(SECRET_D);
    expect(config.webDistDir).toMatch(/apps\/web\/dist$/);
  });

  it("reads the dev login and the port", () => {
    const config = parseConfig({ ...validEnv, DEV_LOGIN: "other@localhost", PORT: "9000" });
    expect(config.authMode).toEqual({ kind: "dev", login: "other@localhost" });
    expect(config.port).toBe(9000);
  });

  it("parses tailscale mode and ignores DEV_LOGIN", () => {
    const config = parseConfig({ ...validEnv, AUTH_MODE: "tailscale", DEV_LOGIN: "x@localhost" });
    expect(config.authMode).toEqual({ kind: "tailscale" });
  });

  it.each(["AUTH_MODE", "JWT_ISSUER", "JWT_PRIVATE_JWK"])("requires %s", (name) => {
    expect(() => parseConfig({ ...validEnv, [name]: undefined })).toThrow(name);
    expect(() => parseConfig({ ...validEnv, [name]: "" })).toThrow(name);
  });

  it("rejects an unknown AUTH_MODE", () => {
    expect(() => parseConfig({ ...validEnv, AUTH_MODE: "none" })).toThrow("AUTH_MODE");
  });

  it.each(["0", "65536", "80.5", "http", "-1"])("rejects PORT %s", (port) => {
    expect(() => parseConfig({ ...validEnv, PORT: port })).toThrow("PORT");
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
