import { useEffect, useRef } from "react";
import processingUrl from "./assets/ui/voice-processing.svg";
import { MAX_RECORDING_SECONDS } from "./voiceAudio.ts";
import type { VoiceState } from "./useVoiceInput.ts";

const WAVEFORM_FLOOR_DB = -72;
const WAVEFORM_CEILING_DB = -18;

function duration(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function VoiceWaveform({ stream }: { stream: MediaStream }) {
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = element.current;
    if (root === null || typeof AudioContext !== "function") return;
    let context: AudioContext;
    try { context = new AudioContext(); } catch { return; }
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    const source = context.createMediaStreamSource(stream);
    source.connect(analyser);
    void context.resume().catch(() => {});
    const samples = new Float32Array(analyser.fftSize);
    const bars = [...root.children];
    const levels = bars.map(() => 4);
    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
    let lastUpdate = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      if (now - lastUpdate < (reducedMotion.matches ? 500 : 90)) return;
      lastUpdate = now;
      analyser.getFloatTimeDomainData(samples);
      const rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
      const decibels = 20 * Math.log10(Math.max(rms, 0.0001));
      const level = Math.max(0, Math.min(1, (decibels - WAVEFORM_FLOOR_DB) / (WAVEFORM_CEILING_DB - WAVEFORM_FLOOR_DB)));
      levels.shift();
      levels.push(4 + level * 34);
      bars.forEach((bar, index) => {
        if (bar instanceof HTMLElement) bar.style.height = `${levels[index]}px`;
      });
    }, 100);
    return () => {
      clearInterval(timer);
      source.disconnect();
      analyser.disconnect();
      void context.close().catch(() => {});
    };
  }, [stream]);
  return <div className="voice-waveform" ref={element} aria-hidden="true">
    {Array.from({ length: 40 }, (_, index) => <span key={index} />)}
  </div>;
}

type ActiveVoiceState = Exclude<VoiceState, { kind: "idle" } | { kind: "review" }>;

export function VoiceInput({ state, onCancel, onFinish, onRetry, retryDisabled }: {
  state: ActiveVoiceState;
  onCancel: () => void;
  onFinish: () => void;
  onRetry: () => void;
  retryDisabled: boolean;
}) {
  const failed = state.kind === "failed";
  const error = state.kind === "error";
  const title = state.kind === "recording" ? "Listening…"
    : state.kind === "transcribing" ? "Transcribing…"
    : state.kind === "requesting" ? "Waiting for microphone…"
    : failed ? "Couldn’t transcribe this recording." : state.message;
  return <div className="voice-status" data-state={state.kind}>
    <div className="voice-heading">
      <span className="voice-status-text" role={failed || error ? "alert" : "status"}>{title}</span>
      {state.kind === "recording" && <span className="voice-timer" aria-live="off">{duration(state.seconds)} / {duration(MAX_RECORDING_SECONDS)}</span>}
    </div>
    <div className="voice-controls">
      {state.kind === "recording" ? <VoiceWaveform stream={state.stream} />
        : <div className="voice-support">
          {(state.kind === "transcribing" || state.kind === "requesting") && <span className="voice-processing" style={{ maskImage: `url("${processingUrl}")` }} aria-hidden="true" />}
          <span>{state.kind === "transcribing" ? <><span className="voice-wide-copy">Your words will appear in the draft.</span><span className="voice-narrow-copy">Adding your words…</span></>
            : state.kind === "requesting" ? "Allow access in your browser."
            : failed ? <><span className="voice-wide-copy">Your recording is still here.</span><span className="voice-narrow-copy">Recording kept.</span></> : "Your draft is unchanged."}</span>
        </div>}
      <button type="button" className="voice-action" aria-label={failed ? "Discard recording" : error ? "Dismiss voice error" : "Cancel voice input"} onClick={onCancel}>{failed ? "Discard" : error ? "Dismiss" : "Cancel"}</button>
      {state.kind === "recording" && <button type="button" className="voice-action voice-primary" aria-label="Finish recording" onClick={onFinish}>Done</button>}
      {failed && <button type="button" className="voice-action voice-primary" aria-label="Retry transcription" disabled={retryDisabled} onClick={onRetry}>Try again</button>}
    </div>
    {failed && <span className="voice-failure-detail">{state.message}</span>}
  </div>;
}
