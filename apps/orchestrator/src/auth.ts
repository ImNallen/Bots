export type AuthMode = { kind: "tailscale" } | { kind: "dev"; login: string; computerToken: string };

export type Identity = {
  subject: string;
  email: string;
  displayName: string;
};

export type RejectionReason =
  | "missing-tailscale-login"
  | "proxied-request"
  | "non-loopback-host";

export type IdentityResult =
  | { kind: "ok"; identity: Identity }
  | { kind: "rejected"; reason: RejectionReason };

export const REJECTION_STATUS = {
  "missing-tailscale-login": 401,
  "proxied-request": 403,
  "non-loopback-host": 403,
} as const satisfies Record<RejectionReason, number>;

const PROXY_HEADERS = [
  "tailscale-user-login",
  "x-forwarded-for",
  "x-forwarded-host",
  "forwarded",
];

const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

export function identityFor(args: { provider: AuthMode["kind"]; login: string }): Identity {
  return {
    subject: `${args.provider}:${args.login}`,
    email: args.login,
    displayName: args.login,
  };
}

export function resolveIdentity(args: { mode: AuthMode; headers: Headers }): IdentityResult {
  const { mode, headers } = args;
  switch (mode.kind) {
    case "tailscale": {
      const login = headers.get("tailscale-user-login");
      if (login === null || login === "") {
        return { kind: "rejected", reason: "missing-tailscale-login" };
      }
      return { kind: "ok", identity: identityFor({ provider: "tailscale", login }) };
    }
    case "dev": {
      if (PROXY_HEADERS.some((name) => headers.has(name))) {
        return { kind: "rejected", reason: "proxied-request" };
      }
      if (!LOOPBACK_HOST.test(headers.get("host") ?? "")) {
        return { kind: "rejected", reason: "non-loopback-host" };
      }
      return { kind: "ok", identity: identityFor({ provider: "dev", login: mode.login }) };
    }
  }
}
