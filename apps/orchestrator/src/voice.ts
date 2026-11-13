import { api } from "@bots/convex";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Doc } from "@bots/convex/dataModel";
import { REJECTION_STATUS, resolveIdentity, type AuthMode, type Identity } from "./auth.ts";
import { PROVIDER_LABEL, type ModelProvider } from "./mistral.ts";
import { decryptApiKey } from "./secrets.ts";
import type { Service } from "./service.ts";

const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const transcript = z.object({ text: z.string().max(64 * 1024) });

type VoiceModel = NonNullable<Doc<"users">["voiceModel"]>;

// Both Together models cost $0.0015 a minute. Together's guide says language defaults to en, so a request asks it to detect the
// language. A probe on 2026-11-13 showed both models writing Swedish speech as Swedish.
const TOGETHER_VOICE_MODELS: Record<Exclude<VoiceModel, "voxtral">, string> = {
  "whisper-large-v3": "openai/whisper-large-v3",
  "parakeet-v3": "nvidia/parakeet-tdt-0.6b-v3",
};

export type VoiceRequest = { provider: ModelProvider; model: string; fields: Record<string, string> };

export function voiceRequest(choice: VoiceModel, voxtralModel: string): VoiceRequest {
  return choice === "voxtral"
    ? { provider: "mistral", model: voxtralModel, fields: {} }
    : { provider: "together", model: TOGETHER_VOICE_MODELS[choice], fields: { language: "auto" } };
}

export function audioFormat(type: string, bytes: Uint8Array): "webm" | "ogg" | "wav" | null {
  const mime = type.split(";")[0]?.trim().toLowerCase();
  const head = Buffer.from(bytes.subarray(0, 12));
  if (mime === "audio/webm" && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return "webm";
  if (mime === "audio/ogg" && head.toString("ascii", 0, 4) === "OggS") return "ogg";
  if (mime === "audio/wav" && head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WAVE") return "wav";
  return null;
}

export function voiceRoutes(args: {
  authMode: AuthMode; service: Pick<Service, "query">; masterKey: Buffer; mistralBaseUrl: string; togetherBaseUrl: string; model: string;
}) {
  const app = new Hono<{ Variables: { identity: Identity } }>();
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    const identity = resolveIdentity({ mode: args.authMode, headers: c.req.raw.headers });
    if (identity.kind === "rejected") return c.json({ error: identity.reason }, REJECTION_STATUS[identity.reason]);
    c.set("identity", identity.identity);
    await next();
  });
  app.post("/:botId", bodyLimit({ maxSize: MAX_AUDIO_BYTES, onError: (c) => c.json({ error: "That recording is too large. Record a shorter message." }, 413) }), async (c) => {
    // Browser audio types require a preflight across origins. This listener grants none.
    const type = c.req.header("content-type") ?? "";
    if (!["audio/webm", "audio/ogg", "audio/wav"].includes(type.split(";")[0]?.trim().toLowerCase() ?? "")) return c.json({ error: "Send a WebM, Ogg, or WAV recording." }, 415);
    try {
      const owner = await args.service.query(api.bots.ownerForViewer, { botId: c.req.param("botId"), viewerSubject: c.get("identity").subject });
      if (owner === null) return c.json({ error: "Bot not found." }, 404);
      const request = voiceRequest(await args.service.query(api.users.voiceModelFor, { ownerId: owner.ownerId }), args.model);
      const { provider } = request;
      const label = PROVIDER_LABEL[provider];
      const credential = await args.service.query(api.credentials.ciphertextFor, { ownerId: owner.ownerId, provider });
      if (credential === null) return c.json({ error: `Add a ${label} key in Settings to use voice input.` }, 400);
      let apiKey: string;
      try { apiKey = decryptApiKey({ masterKey: args.masterKey, ownerId: owner.ownerId, provider, encrypted: credential }); }
      catch { return c.json({ error: `Your ${label} key could not be read. Add it again in Settings.` }, 400); }
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      const format = audioFormat(type, bytes);
      if (bytes.length < 16 || format === null) return c.json({ error: "That recording could not be read. Try recording again." }, 422);
      const form = new FormData();
      form.set("model", request.model);
      for (const [name, value] of Object.entries(request.fields)) form.set(name, value);
      form.set("file", new File([bytes], `recording.${format}`, { type: `audio/${format}` }));
      const baseUrl = provider === "together" ? args.togetherBaseUrl : args.mistralBaseUrl;
      const response = await fetch(`${baseUrl}/v1/audio/transcriptions`, {
        method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: form,
        signal: AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(60_000)]),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401 || response.status === 403) return c.json({ error: `${label} rejected voice transcription with this key. Check your key in Settings.` }, 400);
        if (response.status === 429) return c.json({ error: "Transcription is busy. Wait a moment and retry." }, 429);
        if (response.status === 400 || response.status === 422) return c.json({ error: "That recording could not be transcribed. Try recording again." }, 422);
        return c.json({ error: "Transcription is unavailable. Try again." }, 502);
      }
      const result = transcript.safeParse(await response.json().catch(() => null));
      if (!result.success) return c.json({ error: "Transcription returned an unexpected response. Try again." }, 502);
      const text = result.data.text.trim();
      if (text === "") return c.json({ error: "No speech was detected. Try recording again." }, 422);
      return c.json({ text });
    } catch {
      return c.json({ error: "Transcription could not finish. Try again." }, 502);
    }
  });
  return app;
}
