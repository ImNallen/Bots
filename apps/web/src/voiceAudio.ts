export const MAX_RECORDING_SECONDS = 120;
export const MAX_RECORDING_BYTES = 8 * 1024 * 1024;
const RECORDING_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/ogg", "audio/mp4"];

export function recordingType(isSupported: (type: string) => boolean): string | null {
  return RECORDING_TYPES.find(isSupported) ?? null;
}

export function appendTranscript(draft: string, text: string): string {
  const words = text.trim();
  if (words === "") return draft;
  return draft + (draft === "" || /\s$/.test(draft) ? "" : " ") + words;
}

export function encodeMonoWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const label = (at: number, text: string) => { for (let index = 0; index < text.length; index++) view.setUint8(at + index, text.charCodeAt(index)); };
  label(0, "RIFF"); view.setUint32(4, buffer.byteLength - 8, true); label(8, "WAVE"); label(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); label(36, "data"); view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index++) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    view.setInt16(44 + index * 2, sample * (sample < 0 ? 32768 : 32767), true);
  }
  return buffer;
}

export async function prepareRecording(blob: Blob): Promise<Blob> {
  if (blob.type.split(";")[0] !== "audio/mp4") return blob;
  const decoded = await new OfflineAudioContext(1, 1, 16_000).decodeAudioData(await blob.arrayBuffer());
  if (decoded.duration > MAX_RECORDING_SECONDS + 1) throw new Error("Recording too long");
  const mono = new Float32Array(decoded.length);
  for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
    const samples = decoded.getChannelData(channel);
    for (let index = 0; index < mono.length; index++) mono[index] = (mono[index] ?? 0) + (samples[index] ?? 0) / decoded.numberOfChannels;
  }
  return new Blob([encodeMonoWav(mono, decoded.sampleRate)], { type: "audio/wav" });
}
