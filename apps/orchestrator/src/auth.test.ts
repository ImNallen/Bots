import { describe, expect, it } from "vitest";
import { resolveIdentity, type AuthMode } from "./auth.ts";

const dev: AuthMode = { kind: "dev", login: "dev@localhost", computerToken: "token" };
const tailscale: AuthMode = { kind: "tailscale" };

describe("tailscale mode", () => {
  it("resolves the identity from Tailscale-User-Login", () => {
    const headers = new Headers({ "Tailscale-User-Login": "adam@example.com" });
    expect(resolveIdentity({ mode: tailscale, headers })).toEqual({
      kind: "ok",
      identity: {
        subject: "tailscale:adam@example.com",
        email: "adam@example.com",
        displayName: "adam@example.com",
      },
    });
  });

  it("uses the login as the display name and ignores Tailscale-User-Name", () => {
    const headers = new Headers({
      "Tailscale-User-Login": "adam@example.com",
      "Tailscale-User-Name": "Someone Else",
    });
    const result = resolveIdentity({ mode: tailscale, headers });
    expect(result).toMatchObject({ identity: { displayName: "adam@example.com" } });
  });

  it.each([
    ["absent", new Headers()],
    ["empty", new Headers({ "Tailscale-User-Login": "" })],
    ["only Tailscale-User-Name", new Headers({ "Tailscale-User-Name": "Adam" })],
  ])("rejects when the login is %s", (_label, headers) => {
    expect(resolveIdentity({ mode: tailscale, headers })).toEqual({
      kind: "rejected",
      reason: "missing-tailscale-login",
    });
  });

  it("accepts forwarding headers, because tailscale serve adds them", () => {
    const headers = new Headers({
      "Tailscale-User-Login": "adam@example.com",
      "X-Forwarded-For": "100.64.0.1",
      Host: "control.tailnet.ts.net",
    });
    expect(resolveIdentity({ mode: tailscale, headers }).kind).toBe("ok");
  });
});

describe("dev mode", () => {
  it.each(["localhost", "localhost:5173", "LOCALHOST", "127.0.0.1", "127.0.0.1:8787", "[::1]", "[::1]:8787"])(
    "resolves the fixed login for Host %s",
    (host) => {
      expect(resolveIdentity({ mode: dev, headers: new Headers({ Host: host }) })).toEqual({
        kind: "ok",
        identity: {
          subject: "dev:dev@localhost",
          email: "dev@localhost",
          displayName: "dev@localhost",
        },
      });
    },
  );

  it.each(["Tailscale-User-Login", "X-Forwarded-For", "X-Forwarded-Host", "Forwarded"])(
    "rejects a request carrying %s",
    (name) => {
      const headers = new Headers({ Host: "localhost", [name]: "anything" });
      expect(resolveIdentity({ mode: dev, headers })).toEqual({
        kind: "rejected",
        reason: "proxied-request",
      });
    },
  );

  it("rejects a forwarding header even when its value is empty", () => {
    const headers = new Headers({ Host: "localhost", "X-Forwarded-For": "" });
    expect(resolveIdentity({ mode: dev, headers }).kind).toBe("rejected");
  });

  it.each([
    "evil.example",
    "evil.example:8787",
    "localhost.evil.example",
    "127.0.0.1.nip.io",
    "evil.example#localhost",
    "localhost@evil.example",
    "[::1]evil.example",
    "[::2]:8787",
    "127.0.0.2",
    "localhost:port",
    "",
  ])("rejects Host %j", (host) => {
    expect(resolveIdentity({ mode: dev, headers: new Headers({ Host: host }) })).toEqual({
      kind: "rejected",
      reason: "non-loopback-host",
    });
  });

  it("rejects a request with no Host header", () => {
    expect(resolveIdentity({ mode: dev, headers: new Headers() })).toEqual({
      kind: "rejected",
      reason: "non-loopback-host",
    });
  });
});
