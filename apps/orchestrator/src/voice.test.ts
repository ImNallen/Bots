import { describe, expect, it } from "vitest";
import { audioFormat, voiceRequest } from "./voice.ts";

describe("recording signatures", () => {
  it("accepts matching WebM, Ogg, and WAV containers", () => {
    expect(audioFormat("audio/webm;codecs=opus", new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]))).toBe("webm");
    expect(audioFormat("audio/ogg", new TextEncoder().encode("OggS"))).toBe("ogg");
    expect(audioFormat("audio/wav", new TextEncoder().encode("RIFF1234WAVE"))).toBe("wav");
  });
  it("refuses renamed text, mismatched containers, and unsupported audio", () => {
    expect(audioFormat("audio/webm", new TextEncoder().encode("not audio"))).toBeNull();
    expect(audioFormat("audio/webm", new TextEncoder().encode("RIFF1234WAVE"))).toBeNull();
    expect(audioFormat("audio/mp4", new TextEncoder().encode("ftyp"))).toBeNull();
  });
});

describe("which service and model a recording goes to", () => {
  it("sends Voxtral to Mistral with the configured model and no extra fields, as before", () => {
    expect(voiceRequest("voxtral", "voxtral-mini-transcribe-3-0")).toEqual({ provider: "mistral", model: "voxtral-mini-transcribe-3-0", fields: {} });
  });

  it("sends Whisper and Parakeet to Together, and asks it to detect the language instead of assuming English", () => {
    expect(voiceRequest("whisper-large-v3", "voxtral")).toEqual({ provider: "together", model: "openai/whisper-large-v3", fields: { language: "auto" } });
    expect(voiceRequest("parakeet-v3", "voxtral")).toEqual({ provider: "together", model: "nvidia/parakeet-tdt-0.6b-v3", fields: { language: "auto" } });
  });
});
