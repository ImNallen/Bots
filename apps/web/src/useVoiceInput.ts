import type { Id } from "@bots/convex/dataModel";
import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_RECORDING_BYTES, MAX_RECORDING_SECONDS, prepareRecording, recordingType } from "./voiceAudio.ts";

export type VoiceState =
  | { kind: "idle" }
  | { kind: "requesting" }
  | { kind: "recording"; seconds: number; stream: MediaStream }
  | { kind: "transcribing" }
  | { kind: "review" }
  | { kind: "failed"; message: string; audio: Blob }
  | { kind: "error"; message: string };

type Capture = {
  kind: "recording"; stream: MediaStream; recorder: MediaRecorder;
  timer: ReturnType<typeof setInterval> | null; started: number; chunks: Blob[]; bytes: number;
};
type Session = { kind: "permission" } | Capture | { kind: "transcribing"; controller: AbortController };

function release(session: Session | null) {
  if (session?.kind === "transcribing") session.controller.abort();
  if (session?.kind === "recording") {
    if (session.timer !== null) clearInterval(session.timer);
    if (session.recorder.state !== "inactive") session.recorder.stop();
    for (const track of session.stream.getTracks()) track.stop();
  }
}

function microphoneProblem(error: unknown): string {
  const name = typeof error === "object" && error !== null && "name" in error ? error.name : null;
  if (name === "NotAllowedError" || name === "SecurityError") return "Microphone access was denied. Allow it in your browser, then try again.";
  if (name === "NotFoundError") return "No microphone was found. Connect one and try again.";
  if (name === "NotReadableError") return "Your microphone is unavailable. Check that another app isn't using it.";
  return "Recording could not start. Check your microphone and try again.";
}

export function useVoiceInput({ botId, onTranscript, visible }: { botId: Id<"bots">; onTranscript: (text: string) => void; visible: boolean }) {
  const [state, setState] = useState<VoiceState>({ kind: "idle" });
  const current = useRef<Session | null>(null);
  const mimeType = typeof MediaRecorder === "function" && typeof navigator.mediaDevices?.getUserMedia === "function" && window.isSecureContext
    ? recordingType((type) => MediaRecorder.isTypeSupported(type)) : null;

  const cancel = useCallback(() => {
    const session = current.current; current.current = null;
    release(session); setState({ kind: "idle" });
  }, []);

  useEffect(() => {
    const stopCapture = () => { if (current.current?.kind === "permission" || current.current?.kind === "recording") cancel(); };
    const visibility = () => { if (document.hidden) stopCapture(); };
    const modalFocus = (event: FocusEvent) => { if (event.target instanceof Element && event.target.closest("dialog[open]")) stopCapture(); };
    document.addEventListener("visibilitychange", visibility);
    document.addEventListener("focusin", modalFocus);
    window.addEventListener("pagehide", stopCapture);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      document.removeEventListener("focusin", modalFocus);
      window.removeEventListener("pagehide", stopCapture);
      const session = current.current; current.current = null; release(session);
    };
  }, [cancel]);
  useEffect(() => { if (!visible) cancel(); }, [visible, cancel]);
  useEffect(() => {
    if (state.kind !== "review") return;
    const timer = setTimeout(() => setState((previous) => previous.kind === "review" ? { kind: "idle" } : previous), 4000);
    return () => clearTimeout(timer);
  }, [state.kind]);

  async function transcribe(audio: Blob) {
    if (current.current !== null) return;
    const session: Session = { kind: "transcribing", controller: new AbortController() };
    current.current = session; setState({ kind: "transcribing" });
    let prepared = audio;
    try {
      try { prepared = await prepareRecording(audio); }
      catch { throw new Error("This browser couldn't prepare the recording. Try recording again."); }
      if (current.current !== session) return;
      if (prepared.size === 0 || prepared.size > MAX_RECORDING_BYTES) throw new Error("That recording is too large. Record a shorter message.");
      const response = await fetch(`/api/voice/${botId}`, {
        method: "POST", headers: { "Content-Type": prepared.type }, body: prepared,
        signal: AbortSignal.any([session.controller.signal, AbortSignal.timeout(75_000)]),
      });
      const body: unknown = await response.json().catch(() => null);
      if (current.current !== session) return;
      if (!response.ok) {
        const message = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : "Transcription could not finish. Try again.";
        if (response.status === 413 || response.status === 415 || response.status === 422) { setState({ kind: "error", message }); return; }
        throw new Error(message);
      }
      if (typeof body !== "object" || body === null || !("text" in body) || typeof body.text !== "string" || body.text.trim() === "") throw new Error("Transcription returned an unexpected response. Try again.");
      onTranscript(body.text);
      setState({ kind: "review" });
    } catch (error) {
      if (current.current === session) setState({ kind: "failed", message: error instanceof Error && error.name === "TimeoutError" ? "Transcription timed out. Try again." : error instanceof TypeError ? "Could not reach transcription. Check your connection and retry." : error instanceof Error ? error.message : "Transcription could not finish. Try again.", audio: prepared });
    } finally {
      if (current.current === session) current.current = null;
    }
  }

  function finish() {
    const capture = current.current;
    if (capture?.kind !== "recording" || capture.recorder.state === "inactive") return;
    setState({ kind: "transcribing" });
    release(capture);
  }

  async function start() {
    if (current.current !== null || mimeType === null || !visible) return;
    const permission: Session = { kind: "permission" };
    current.current = permission; setState({ kind: "requesting" });
    let stream: MediaStream | null = null;
    let capture: Capture | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      if (current.current !== permission) { for (const track of stream.getTracks()) track.stop(); return; }
      const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 64_000 });
      const recording: Capture = { kind: "recording", stream, recorder, timer: null, started: performance.now(), chunks: [], bytes: 0 };
      capture = recording; current.current = recording;
      recorder.ondataavailable = (event) => {
        if (current.current !== recording || event.data.size === 0) return;
        recording.chunks.push(event.data); recording.bytes += event.data.size;
        if (recording.bytes > MAX_RECORDING_BYTES) {
          current.current = null; release(recording);
          setState({ kind: "error", message: "That recording is too large. Record a shorter message." });
        }
      };
      recorder.onerror = () => {
        if (current.current !== recording) return;
        current.current = null; release(recording);
        setState({ kind: "error", message: "Recording was interrupted. Try recording again." });
      };
      recorder.onstop = () => {
        if (current.current !== recording) return;
        release(recording); current.current = null;
        const audio = new Blob(recording.chunks, { type: recorder.mimeType || mimeType });
        if (audio.size === 0) setState({ kind: "error", message: "No audio was recorded. Try again." });
        else void transcribe(audio);
      };
      recorder.start(1000);
      setState({ kind: "recording", seconds: 0, stream });
      recording.timer = setInterval(() => {
        if (current.current !== recording || recording.recorder.state !== "recording") return;
        const seconds = Math.floor((performance.now() - recording.started) / 1000);
        if (seconds >= MAX_RECORDING_SECONDS) finish();
        else setState((previous) => previous.kind === "recording" && previous.seconds === seconds ? previous : { kind: "recording", seconds, stream: recording.stream });
      }, 250);
    } catch (error) {
      if (stream !== null) for (const track of stream.getTracks()) track.stop();
      if (current.current === permission || (capture !== null && current.current === capture)) {
        const session = current.current; current.current = null; release(session);
        setState({ kind: "error", message: microphoneProblem(error) });
      }
    }
  }

  return {
    state, supported: mimeType !== null, start, finish, cancel,
    pending: state.kind === "requesting" || state.kind === "recording" || state.kind === "transcribing" || state.kind === "failed",
    retry: () => { if (state.kind === "failed") void transcribe(state.audio); },
  };
}
