import { describe, expect, it } from "vitest";
import { audioFormat } from "./voice.ts";

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
