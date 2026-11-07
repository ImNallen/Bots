import { describe, expect, it } from "vitest";
import { appendTranscript, encodeMonoWav, recordingType } from "./voiceAudio.ts";

describe("voice draft insertion", () => {
  it("preserves edits, line breaks, and Unicode while appending words", () => {
    expect(appendTranscript("Keep this draft.", "  Meet at the café.  ")).toBe("Keep this draft. Meet at the café.");
    expect(appendTranscript("A list:\n", "First item")).toBe("A list:\nFirst item");
    expect(appendTranscript("", "Hej!")).toBe("Hej!");
    expect(appendTranscript("Existing  ", "  ")).toBe("Existing  ");
  });
});

describe("browser recording formats", () => {
  it("prefers provider-supported formats and retains an MP4 conversion fallback", () => {
    expect(recordingType(() => true)).toBe("audio/webm;codecs=opus");
    expect(recordingType((type) => type === "audio/mp4")).toBe("audio/mp4");
    expect(recordingType(() => false)).toBeNull();
  });
});

describe("mono WAV encoding", () => {
  it("writes the frame length, PCM format, rate, and clipped signed samples", () => {
    const wav = encodeMonoWav(new Float32Array([-2, -1, 0, 0.5, 1, 2]), 16_000);
    const view = new DataView(wav);
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(wav.slice(8, 12))).toBe("WAVE");
    expect(view.getUint32(4, true)).toBe(wav.byteLength - 8);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(28, true)).toBe(32_000);
    expect(view.getUint32(40, true)).toBe(12);
    expect(Array.from({ length: 6 }, (_, index) => view.getInt16(44 + index * 2, true))).toEqual([-32768, -32768, 0, 16383, 32767, 32767]);
  });
});
