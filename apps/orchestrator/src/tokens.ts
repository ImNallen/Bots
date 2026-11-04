import { SignJWT, importJWK } from "jose";
import type { Identity } from "./auth.ts";
import type { Config } from "./config.ts";

// Convex checks this against applicationID in packages/convex/convex/auth.config.ts.
const AUDIENCE = "bots";
const USER_TOKEN_TTL_SECONDS = 60 * 60;
const SERVICE_TOKEN_TTL_SECONDS = 10 * 60;
// packages/convex/convex/identity.ts checks this exact subject.
const SERVICE_SUBJECT = "service:orchestrator";

export type IssuedToken = { token: string; expiresAt: number };

export type TokenIssuer = {
  forUser: (identity: Identity) => Promise<IssuedToken>;
  forService: () => Promise<IssuedToken>;
};

export async function createTokenIssuer(config: Pick<Config, "issuer" | "signingKey">): Promise<TokenIssuer> {
  const signingKey = await importJWK(config.signingKey.jwk, "ES256");

  async function sign(args: {
    subject: string;
    claims: Record<string, string>;
    ttlSeconds: number;
  }): Promise<IssuedToken> {
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresAt = issuedAt + args.ttlSeconds;
    const token = await new SignJWT(args.claims)
      .setProtectedHeader({ alg: "ES256", kid: config.signingKey.kid, typ: "JWT" })
      .setSubject(args.subject)
      .setIssuer(config.issuer)
      .setAudience(AUDIENCE)
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAt)
      .sign(signingKey);
    return { token, expiresAt };
  }

  return {
    forUser: (identity) =>
      sign({
        subject: identity.subject,
        claims: { email: identity.email, name: identity.displayName },
        ttlSeconds: USER_TOKEN_TTL_SECONDS,
      }),
    forService: () => sign({ subject: SERVICE_SUBJECT, claims: {}, ttlSeconds: SERVICE_TOKEN_TTL_SECONDS }),
  };
}
