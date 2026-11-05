import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";

export type DictationState = "idle" | "recording" | "transcribing";

const MAX_MS = 3 * 60_000;
const TYPES = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm", "audio/ogg;codecs=opus"];

function extension(mime: string): string {
  if (mime.includes("mp4")) return "m4a";
  if (mime.includes("ogg")) return "ogg";
  return "webm";
}

export function dictationSupported(): boolean {
  return typeof window !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";
}

/**
 * Record a spoken question in the browser and turn it into text with the server's default transcription model.
 * ``level`` is a ref (0–1, updated every frame) so a meter can animate without re-rendering the composer.
 */
export function useDictation({ hint, onText }: { hint?: string; onText: (text: string) => void }) {
  const [state, setState] = useState<DictationState>("idle");
  const [error, setError] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const level = useRef(0);
  const recorder = useRef<MediaRecorder | null>(null);
  const cleanup = useRef<() => void>(() => {});
  const discard = useRef(false);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  const release = useCallback(() => {
    cleanup.current();
    cleanup.current = () => {};
    level.current = 0;
  }, []);

  useEffect(() => () => {
    discard.current = true;
    if (recorder.current?.state === "recording") recorder.current.stop();
    release();
  }, [release]);

  const start = useCallback(async () => {
    if (recorder.current?.state === "recording") return;
    setError("");
    if (!dictationSupported()) {
      setError("This browser can't record audio.");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      const denied = e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "SecurityError");
      setError(denied ? "Microphone access is off. Allow it for this site to ask by voice." : "Couldn't start the microphone.");
      return;
    }
    const mime = TYPES.find((t) => MediaRecorder.isTypeSupported?.(t)) ?? "";
    const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);

    // A level meter, so it's obvious the mic is hearing you.
    let ctx: AudioContext | null = null;
    let frame = 0;
    try {
      ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      const tick = () => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += ((v - 128) / 128) ** 2;
        const rms = Math.sqrt(sum / buf.length);
        level.current = level.current * 0.6 + Math.min(1, rms * 4) * 0.4;
        frame = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      /* no meter, still records */
    }

    const began = Date.now();
    const timer = window.setInterval(() => {
      const ms = Date.now() - began;
      setElapsed(ms);
      if (ms >= MAX_MS && rec.state === "recording") rec.stop();
    }, 200);

    cleanup.current = () => {
      window.clearInterval(timer);
      cancelAnimationFrame(frame);
      stream.getTracks().forEach((t) => t.stop());
      void ctx?.close().catch(() => {});
    };

    rec.onstop = async () => {
      release();
      recorder.current = null;
      if (discard.current || !chunks.length) {
        discard.current = false;
        setState("idle");
        return;
      }
      setState("transcribing");
      const type = rec.mimeType || mime || "audio/webm";
      const form = new FormData();
      form.append("audio", new Blob(chunks, { type }), `question.${extension(type)}`);
      if (hint) form.append("hint", hint);
      try {
        const { text } = await api.post<{ text: string }>("/transcripts/dictate", form);
        if (text) onTextRef.current(text);
        else setError("Didn't catch anything — try again a little closer to the mic.");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setState("idle");
      }
    };

    discard.current = false;
    recorder.current = rec;
    setElapsed(0);
    rec.start(250);
    setState("recording");
  }, [hint, release]);

  /** Stop and transcribe. */
  const stop = useCallback(() => {
    if (recorder.current?.state === "recording") recorder.current.stop();
  }, []);

  /** Stop and throw the recording away. */
  const cancel = useCallback(() => {
    discard.current = true;
    if (recorder.current?.state === "recording") recorder.current.stop();
    else release();
  }, [release]);

  return { state, error, elapsed, level, start, stop, cancel, clearError: () => setError("") };
}

export type Dictation = ReturnType<typeof useDictation>;
