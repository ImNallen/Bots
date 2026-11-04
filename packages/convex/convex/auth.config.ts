import type { AuthConfig } from "convex/server";

export default {
  providers: [
    {
      type: "customJwt",
      // The orchestrator signs this same value into `aud`. See apps/orchestrator/src/main.ts.
      applicationID: "bots",
      issuer: process.env.JWT_ISSUER!,
      jwks: process.env.JWT_JWKS!,
      algorithm: "ES256",
    },
  ],
} satisfies AuthConfig;
