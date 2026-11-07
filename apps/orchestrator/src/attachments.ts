import { api } from "@bots/convex";
import { attachmentContentType, attachmentProblem, MAX_ATTACHMENT_BYTES, type AttachmentContentType } from "@bots/convex/attachmentFiles";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ConvexError } from "convex/values";
import { z } from "zod";
import { REJECTION_STATUS, resolveIdentity, type AuthMode, type Identity } from "./auth.ts";
import type { Service } from "./service.ts";

export function fileContentProblem(bytes: Uint8Array, type: AttachmentContentType): string | null {
  const head = Buffer.from(bytes.subarray(0, 12));
  if (type === "image/png" && !head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "This file is not a PNG image.";
  if (type === "image/jpeg" && !(head[0] === 255 && head[1] === 216 && head[2] === 255)) return "This file is not a JPEG image.";
  if (type === "image/webp" && !(head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WEBP")) return "This file is not a WebP image.";
  if (type === "application/pdf" && head.toString("ascii", 0, 5) !== "%PDF-") return "This file is not a PDF document.";
  if (type === "text/plain") {
    try {
      if (new TextDecoder("utf-8", { fatal: true }).decode(bytes).includes("\0")) return "Choose a UTF-8 text file, without binary content.";
    } catch {
      return "Choose a UTF-8 text file.";
    }
  }
  return null;
}

function requestError(error: unknown): string {
  return error instanceof ConvexError && typeof error.data === "string" ? error.data : "The file could not be uploaded. Try again.";
}

export function attachmentRoutes(args: { authMode: AuthMode; service: Pick<Service, "query" | "mutation"> }) {
  const app = new Hono<{ Variables: { identity: Identity } }>();
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Cross-Origin-Resource-Policy", "same-origin");
    const identity = resolveIdentity({ mode: args.authMode, headers: c.req.raw.headers });
    if (identity.kind === "rejected") return c.json({ error: identity.reason }, REJECTION_STATUS[identity.reason]);
    c.set("identity", identity.identity);
    await next();
  });

  app.post("/:botId", bodyLimit({ maxSize: MAX_ATTACHMENT_BYTES, onError: (c) => c.json({ error: "Files can be up to 8 MB." }, 413) }), async (c) => {
    // This type and the custom headers require a preflight for cross-origin uploads. This server grants none.
    if (c.req.header("content-type") !== "application/octet-stream") return c.json({ error: "Send the file as application/octet-stream." }, 415);
    let name: string;
    try { name = decodeURIComponent(c.req.header("x-file-name") ?? ""); } catch { return c.json({ error: "Invalid file name." }, 400); }
    const type = attachmentContentType(name, c.req.header("x-file-type") ?? "");
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    const problem = attachmentProblem({ name, type: type ?? "", size: bytes.length });
    if (problem !== null || type === null) return c.json({ error: problem ?? "Unsupported file type." }, 400);
    const contentProblem = fileContentProblem(bytes, type);
    if (contentProblem !== null) return c.json({ error: contentProblem }, 400);
    try {
      const upload = await args.service.mutation(api.attachments.beginForService, { botId: c.req.param("botId"), subject: c.get("identity").subject, name, contentType: type, size: bytes.length });
      const response = await fetch(upload.uploadUrl, { method: "POST", headers: { "Content-Type": type }, body: bytes, signal: AbortSignal.timeout(60_000) });
      if (!response.ok) return c.json({ error: "The file could not be stored. Try again." }, 502);
      const stored = z.object({ storageId: z.string() }).parse(await response.json());
      const result = await args.service.mutation(api.attachments.completeForService, { id: upload.id, storageId: stored.storageId });
      return result.kind === "ready" ? c.json(result.file, 201) : c.json({ error: "The file upload did not finish. Try again." }, 400);
    } catch (error) {
      return c.json({ error: requestError(error) }, error instanceof ConvexError ? 400 : 502);
    }
  });

  app.get("/:id", async (c) => {
    try {
      const file = await args.service.query(api.attachments.downloadForService, { id: c.req.param("id"), subject: c.get("identity").subject });
      if (file?.url === null || file === null) return c.json({ error: "Attachment not found." }, 404);
      const response = await fetch(file.url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok || response.body === null) return c.json({ error: "The file is unavailable. Try again." }, 502);
      c.header("Content-Type", file.contentType);
      c.header("Content-Length", String(file.size));
      c.header("Content-Disposition", `${file.contentType.startsWith("image/") && c.req.query("preview") === "1" ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name).replaceAll("'", "%27")}`);
      return c.body(response.body);
    } catch {
      return c.json({ error: "Attachment not found." }, 404);
    }
  });
  return app;
}
