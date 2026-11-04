import { api } from "@bots/convex";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { REJECTION_STATUS, resolveIdentity, type AuthMode, type Identity } from "./auth.ts";
import type { LogFields } from "./log.ts";
import { checkMistralKey } from "./mistral.ts";
import { encryptApiKey } from "./secrets.ts";
import type { Service } from "./service.ts";

const MAX_BODY_BYTES = 4096;
const keyBody = z.strictObject({ key: z.string().trim().min(8).max(512) });

export function keyRoutes(args: {
  authMode: AuthMode;
  masterKey: Buffer;
  mistralBaseUrl: string;
  service: Service;
  log: (fields: LogFields) => void;
}) {
  const { service, log } = args;
  const app = new Hono<{ Variables: { identity: Identity } }>();

  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    const result = resolveIdentity({ mode: args.authMode, headers: c.req.raw.headers });
    if (result.kind === "rejected") {
      log({ level: "warn", event: "key-request-rejected", reason: result.reason });
      return c.json({ error: result.reason }, REJECTION_STATUS[result.reason]);
    }
    c.set("identity", result.identity);
    await next();
  });

  const ownerIdFor = (identity: Identity) =>
    service.mutation(api.users.ensureForService, {
      subject: identity.subject,
      email: identity.email,
      displayName: identity.displayName,
    });

  app.put(
    "/",
    bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: "The request is too large." }, 413) }),
    async (c) => {
      // A browser cannot send this type across origins without a preflight, and this server answers no preflight.
      const contentType = c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase();
      if (contentType !== "application/json") {
        return c.json({ error: "Content-Type must be application/json." }, 415);
      }
      const body = keyBody.safeParse(await c.req.json().catch(() => null));
      if (!body.success) {
        return c.json({ error: "Send a JSON body with a key between 8 and 512 characters." }, 400);
      }
      const apiKey = body.data.key;
      const check = await checkMistralKey({ baseUrl: args.mistralBaseUrl, apiKey });
      switch (check) {
        case "rejected":
          log({ level: "info", event: "key-refused-by-mistral", subject: c.get("identity").subject });
          return c.json({ error: "Mistral rejected this key." }, 400);
        case "unreachable":
          return c.json({ error: "Could not reach Mistral to check this key. Try again." }, 502);
        case "accepted":
          break;
      }
      const ownerId = await ownerIdFor(c.get("identity"));
      const encrypted = encryptApiKey({ masterKey: args.masterKey, ownerId, apiKey });
      await service.mutation(api.credentials.store, { ownerId, ...encrypted });
      log({ level: "info", event: "key-stored", ownerId });
      return c.json({ configured: true, last4: encrypted.last4 });
    },
  );

  app.delete("/", async (c) => {
    const ownerId = await ownerIdFor(c.get("identity"));
    await service.mutation(api.credentials.remove, { ownerId });
    log({ level: "info", event: "key-removed", ownerId });
    return c.json({ configured: false, last4: null });
  });

  return app;
}
