import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export interface QueueItem {
  trackId: number;
  title: string;
  subtitle: string;
  src: string;
  cover?: string;
  /** Where this track starts in the whole work (book chapters), for “Ask” and transcript sync. */
  workOffsetMs?: number;
  link?: string;
}

interface PlayerState {
  queue: QueueItem[];
  index: number;
  playing: boolean;
  positionMs: number;
  durationMs: number;
  rate: number;
  current: QueueItem | null;
  play: (queue: QueueItem[], index?: number, startMs?: number) => void;
  toggle: () => void;
  seek: (ms: number) => void;
  skip: (deltaMs: number) => void;
  next: () => void;
  prev: () => void;
  setRate: (rate: number) => void;
}

const PlayerContext = createContext<PlayerState | null>(null);
const STORAGE_KEY = "audio.player";

export function PlayerProvider({ children }: { children: ReactNode }) {
  const audio = useRef<HTMLAudioElement>(new Audio());
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [positionMs, setPosition] = useState(0);
  const [durationMs, setDuration] = useState(0);
  const [rate, setRateState] = useState(1);
  const pendingSeek = useRef<number | null>(null);

  const current = queue[index] ?? null;

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (saved?.queue?.length) {
        setQueue(saved.queue);
        setIndex(saved.index ?? 0);
        pendingSeek.current = saved.positionMs ?? 0;
        setRateState(saved.rate ?? 1);
      }
    } catch {
      /* storage unavailable */
    }
  }, []);

  useEffect(() => {
    const el = audio.current;
    const onTime = () => setPosition(el.currentTime * 1000);
    const onMeta = () => {
      setDuration(el.duration * 1000);
      if (pendingSeek.current != null) {
        el.currentTime = pendingSeek.current / 1000;
        pendingSeek.current = null;
      }
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnded = () => setIndex((i) => (i + 1 < queue.length ? i + 1 : i));
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("loadedmetadata", onMeta);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("ended", onEnded);
    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("loadedmetadata", onMeta);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("ended", onEnded);
    };
  }, [queue.length]);

  useEffect(() => {
    const el = audio.current;
    if (!current) return;
    if (el.src !== new URL(current.src, location.href).href) {
      const wasPlaying = playing || el.dataset.autoplay === "1";
      el.src = current.src;
      el.playbackRate = rate;
      if (wasPlaying) el.play().catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.src]);

  useEffect(() => {
    const id = window.setInterval(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ queue, index, positionMs: audio.current.currentTime * 1000, rate }));
      } catch {
        /* ignore */
      }
    }, 3000);
    return () => window.clearInterval(id);
  }, [queue, index, rate]);

  const play = useCallback((items: QueueItem[], start = 0, startMs?: number) => {
    const el = audio.current;
    el.dataset.autoplay = "1";
    pendingSeek.current = startMs ?? null;
    setQueue(items);
    setIndex(start);
    if (items[start] && el.src === new URL(items[start].src, location.href).href) {
      if (startMs != null) el.currentTime = startMs / 1000;
      el.play().catch(() => undefined);
    }
  }, []);

  const value = useMemo<PlayerState>(
    () => ({
      queue,
      index,
      playing,
      positionMs,
      durationMs,
      rate,
      current,
      play,
      toggle: () => {
        const el = audio.current;
        if (!el.src) return;
        if (el.paused) el.play().catch(() => undefined);
        else el.pause();
      },
      seek: (ms) => {
        audio.current.currentTime = Math.max(0, ms / 1000);
      },
      skip: (delta) => {
        audio.current.currentTime = Math.max(0, audio.current.currentTime + delta / 1000);
      },
      next: () => setIndex((i) => Math.min(i + 1, queue.length - 1)),
      prev: () => {
        if (audio.current.currentTime > 5) audio.current.currentTime = 0;
        else setIndex((i) => Math.max(0, i - 1));
      },
      setRate: (r) => {
        audio.current.playbackRate = r;
        setRateState(r);
      },
    }),
    [queue, index, playing, positionMs, durationMs, rate, current, play],
  );

  return <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>;
}

export function usePlayer(): PlayerState {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error("usePlayer outside PlayerProvider");
  return ctx;
}
