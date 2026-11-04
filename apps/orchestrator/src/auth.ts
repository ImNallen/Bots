export type AuthMode = { kind: "tailscale" } | { kind: "dev"; login: string };

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

const PROXY_HEADERS = [
  "tailscale-user-login",
  "x-forwarded-for",
  "x-forwarded-host",
  "forwarded",
];

const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

function identityFor(args: { provider: AuthMode["kind"]; login: string }): IdentityResult {
  return {
    kind: "ok",
    identity: {
      subject: `${args.provider}:${args.login}`,
      email: args.login,
      displayName: args.login,
    },
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
      return identityFor({ provider: "tailscale", login });
    }
    case "dev": {
      if (PROXY_HEADERS.some((name) => headers.has(name))) {
        return { kind: "rejected", reason: "proxied-request" };
      }
      if (!LOOPBACK_HOST.test(headers.get("host") ?? "")) {
        return { kind: "rejected", reason: "non-loopback-host" };
      }
      return identityFor({ provider: "dev", login: mode.login });
    }
  }
}
