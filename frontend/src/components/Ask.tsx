import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUp,
  ChevronDown,
  ChevronLeft,
  Lock,
  MessageCircle,
  MessagesSquare,
  Mic,
  Pause,
  Play,
  Plus,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  Square,
  SquarePen,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { api, streamNdjson } from "../api";
import { clock, relative } from "../format";
import { dictationSupported, useDictation, type Dictation } from "../hooks/dictation";
import { usePlayer, type QueueItem } from "../player";
import type { ChatMessage, Conversation } from "../types";
import { workNoun, workQuery, type WorkRef } from "./Listen";
import ModelPicker, { useModels, type ModelChoice } from "./ModelPicker";
import { Button, Empty, Note, Spinner, errorText } from "./ui";

const MODEL_KEY = "audio.askModel";
const SCOPE_KEY = "audio.askWholeWork"; // 0 up to where I am, 2 farthest I've been, 1 whole work
const FARTHEST_KEY = "audio.askFarthest:";

type Scope = "here" | "farthest" | "whole";
const SCOPE_CODES: Record<Scope, number> = { here: 0, whole: 1, farthest: 2 };

/** Phones and small tablets: the width where the sidebar folds away. */
export const COMPACT_QUERY = "(max-width: 860px)";

export function useMedia(query: string): boolean {
  const [match, setMatch] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return match;
}

/** h:mm:ss, the way the server writes the spoiler limit into the grounding warning. */
function hms(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

const WORD_NUMBERS = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty".split(" ");

/** "Chapter 12: The Storm" → "Ch. 12"; "Part Two" → "Part 2"; "Prologue" stays "Prologue". */
function chapterShort(title: string): string {
  const t = title.trim();
  const number = (raw: string) => {
    const low = raw.toLowerCase();
    if (/^\d+$/.test(low)) return String(Number(low));
    if (WORD_NUMBERS.includes(low)) return String(WORD_NUMBERS.indexOf(low) + 1);
    return /^[ivxlc]+$/.test(low) ? raw.toUpperCase() : null;
  };
  // A chapter number wins over a part or book number ("Book 2, Chapter 3" → "Ch. 3").
  for (const [pattern, word] of [
    [/\b(?:chapter|ch\.?)\s+([a-z0-9]+)\b/i, "Ch."],
    [/\b(part|book|section|episode)\s+([a-z0-9]+)\b/i, ""],
  ] as const) {
    const m = t.match(pattern);
    const n = m && number(m[m.length - 1]);
    if (m && n) return `${word || m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()} ${n}`;
  }
  if (/^\d+$/.test(t)) return `Ch. ${Number(t)}`;
  return t.length > 22 ? `${t.slice(0, 20).trimEnd()}…` : t;
}

/** Where in the work a moment falls: the chapter (track) it's in, for the citation chips. */
type ChapterAt = (workMs: number) => { short: string; title: string } | null;

function renderAnswer(text: string, onCite: (ms: number) => void, chapterAt?: ChapterAt): ReactNode[] {
  return text.split(/(\[\d+:\d{2}:\d{2}\])/g).map((part, i) => {
    const m = part.match(/^\[(\d+):(\d{2}):(\d{2})\]$/);
    if (!m) return part;
    const ms = (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000;
    const chapter = chapterAt?.(ms);
    const time = m[1] === "0" ? `${m[2]}:${m[3]}` : `${m[1]}:${m[2]}:${m[3]}`;
    return (
      <button key={i} className="cite" onClick={() => onCite(ms)} title={chapter ? `Play from here · ${chapter.title}` : "Play from here"}>
        <Play size={10} fill="currentColor" />
        {chapter && <span className="cite-ch">{chapter.short} ·</span>}
        {time}
      </button>
    );
  });
}

function stored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function store(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

/**
 * One overlay at a time (the composer or a sheet), kept in the URL as ?ask=… so the phone's back gesture closes it
 * instead of leaving the page.
 */
type Overlay = "compose" | "chats" | "options";
function useOverlay() {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const current = (params.get("ask") as Overlay | null) ?? null;
  const open = useCallback(
    (which: Overlay) => {
      const next = new URLSearchParams(params);
      next.set("ask", which);
      // Replace one overlay with another, so back still goes straight to the conversation.
      setParams(next, { replace: !!current, state: { askOverlay: true } });
    },
    [params, setParams, current],
  );
  const close = useCallback(() => {
    if (!current) return;
    if ((location.state as { askOverlay?: boolean } | null)?.askOverlay) navigate(-1);
    else {
      const next = new URLSearchParams(params);
      next.delete("ask");
      setParams(next, { replace: true });
    }
  }, [current, location.state, navigate, params, setParams]);
  return { current, open, close };
}

/** The visible part of the screen, which shrinks when the on-screen keyboard is up (iOS doesn't resize the page). */
function useVisualViewport() {
  const [box, setBox] = useState<{ height: number; top: number } | null>(null);
  useEffect(() => {
    const v = window.visualViewport;
    if (!v) return;
    const on = () => setBox({ height: v.height, top: v.offsetTop });
    on();
    v.addEventListener("resize", on);
    v.addEventListener("scroll", on);
    document.addEventListener("visibilitychange", on);
    return () => {
      v.removeEventListener("resize", on);
      v.removeEventListener("scroll", on);
      document.removeEventListener("visibilitychange", on);
    };
  }, []);
  return box;
}

function useEscape(onEscape: () => void) {
  const ref = useRef(onEscape);
  ref.current = onEscape;
  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === "Escape" && ref.current();
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);
}

function suggestionsFor(wholeWork: boolean, noun: string): string[] {
  return wholeWork
    ? ["How does it end?", `Summarize the whole ${noun}`, "What are the big themes?", "Who changes the most, and how?"]
    : [
        "What just happened?",
        "Recap the story so far",
        "Who are the main characters so far?",
        "Remind me what happened in the last chapter",
      ];
}

// ───────── small pieces ─────────

/** The fixed spoiler warning sent ahead of each question: there if you want to read it, folded away otherwise. */
function PrefixDisclosure({ text, horizonMs }: { text: string; horizonMs: number }) {
  return (
    <details className="ask-prefix">
      <summary>
        <Lock size={12} />
        <span>
          Sent with your question · <b>no spoilers past {clock(horizonMs)}</b>
        </span>
        <ChevronDown size={14} className="chev" />
      </summary>
      <p>{text}</p>
    </details>
  );
}

/** Bars that follow the mic level, driven straight from the ref so typing never re-renders 60 times a second. */
function LevelBars({ level, bars = 18 }: { level: RefObject<number>; bars?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let frame = 0;
    const history: number[] = Array(bars).fill(0);
    const tick = () => {
      history.push(level.current ?? 0);
      history.shift();
      const el = ref.current;
      if (el)
        for (let i = 0; i < el.children.length; i++)
          (el.children[i] as HTMLElement).style.transform = `scaleY(${0.12 + history[i] * 0.88})`;
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [level, bars]);
  return (
    <div className="level-bars" ref={ref} aria-hidden>
      {Array.from({ length: bars }).map((_, i) => (
        <span key={i} />
      ))}
    </div>
  );
}

/** Recording / transcribing status with stop and discard. */
function DictationStrip({ dictation }: { dictation: Dictation }) {
  if (dictation.state === "transcribing")
    return (
      <div className="dictation-strip">
        <Spinner size={18} />
        <span className="muted">Turning your words into text…</span>
      </div>
    );
  return (
    <div className="dictation-strip recording">
      <button type="button" className="round-btn ghost" onClick={dictation.cancel} aria-label="Discard recording">
        <X size={20} />
      </button>
      <LevelBars level={dictation.level} />
      <span className="tabular dictation-time">{clock(dictation.elapsed)}</span>
      <button type="button" className="round-btn stop" onClick={dictation.stop} aria-label="Stop and use this">
        <Square size={16} fill="currentColor" />
      </button>
    </div>
  );
}

function MiniPlayer() {
  const p = usePlayer();
  if (!p.current) return null;
  return (
    <div className="ask-mini">
      <div className="ask-mini-progress" style={{ width: `${p.durationMs ? (p.positionMs / p.durationMs) * 100 : 0}%` }} />
      {p.current.cover ? <img src={p.current.cover} alt="" /> : <div className="art" />}
      <div className="ask-mini-text">
        <b className="truncate">{p.current.title}</b>
        <span className="tabular">
          {clock(p.positionMs)} / {clock(p.durationMs)}
        </span>
      </div>
      <button type="button" onClick={() => p.skip(-15000)} aria-label="Back 15 seconds">
        <RotateCcw size={18} />
      </button>
      <button type="button" className="play" onClick={p.toggle} aria-label={p.playing ? "Pause" : "Play"}>
        {p.playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" style={{ marginLeft: 2 }} />}
      </button>
    </div>
  );
}

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEscape(onClose);
  return createPortal(
    <div className="sheet-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="sheet-grip" aria-hidden />
        <div className="sheet-head">
          <h3>{title}</h3>
          <button type="button" className="round-btn ghost" onClick={onClose} aria-label="Close">
            <X size={20} />
          </button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/** The phone's full-page question editor: big text area, voice, and Send always above the keyboard. */
function Composer({
  draft,
  setDraft,
  onSend,
  onCancel,
  prefix,
  horizonMs,
  scopeLabel,
  placeholder,
  suggestions,
  dictation,
  dictated,
  focusOnOpen,
}: {
  draft: string;
  setDraft: (v: string) => void;
  onSend: () => void;
  onCancel: () => void;
  prefix: string | null;
  horizonMs: number;
  scopeLabel: string;
  placeholder: string;
  suggestions: string[];
  dictation: Dictation;
  /** Goes up each time dictation adds words, so the cursor follows them (and only then). */
  dictated: number;
  focusOnOpen: boolean;
}) {
  const box = useVisualViewport();
  const ref = useRef<HTMLTextAreaElement>(null);
  useEscape(onCancel);
  useEffect(() => {
    if (focusOnOpen) ref.current?.focus({ preventScroll: true });
    return () => {
      // Closing while the keyboard is up: let go of the focus before the text area disappears, and undo the scroll
      // iOS added for the keyboard. Otherwise the page can stay shifted, so taps miss the question pill and the
      // keyboard won't come back.
      const active = document.activeElement as HTMLElement | null;
      if (active && active !== document.body) active.blur();
      resetIosScroll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Put the cursor at the end after dictation adds words. Typing leaves it where you put it.
  useEffect(() => {
    const el = ref.current;
    if (dictated && el && document.activeElement === el) el.setSelectionRange(el.value.length, el.value.length);
  }, [dictated]);
  const busyMic = dictation.state !== "idle";
  const canSend = !!draft.trim() && !busyMic;

  return createPortal(
    <div
      className="compose"
      role="dialog"
      aria-modal="true"
      aria-label="Ask a question"
      style={box ? { height: box.height, top: box.top } : undefined}
    >
      <header className="compose-head">
        <button type="button" className="compose-cancel" onClick={onCancel}>
          Cancel
        </button>
        <div className="compose-title">
          <b>Ask</b>
          <small>{scopeLabel}</small>
        </div>
        <button type="button" className="compose-send" onClick={onSend} disabled={!canSend} aria-label="Send question">
          <ArrowUp size={20} strokeWidth={2.6} />
        </button>
      </header>
      {prefix && (
        <div className="compose-prefix">
          <PrefixDisclosure text={prefix} horizonMs={horizonMs} />
        </div>
      )}
      <textarea
        ref={ref}
        className="compose-text"
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={resetIosScroll}
        enterKeyHint="send"
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (canSend) onSend();
          }
        }}
      />
      {!draft.trim() && !busyMic && (
        <div className="compose-suggest" aria-label="Suggestions">
          {suggestions.map((s) => (
            <button type="button" key={s} className="chip" onClick={() => (setDraft(s), ref.current?.focus())}>
              {s}
            </button>
          ))}
        </div>
      )}
      <footer className="compose-tools">
        {dictation.error && <div className="dictation-error">{dictation.error}</div>}
        {busyMic ? (
          <DictationStrip dictation={dictation} />
        ) : dictationSupported() ? (
          <div className="compose-mic-row">
            <button
              type="button"
              className="round-btn mic"
              onClick={() => {
                ref.current?.blur(); // the keyboard would cover the recording controls
                void dictation.start();
              }}
              aria-label="Ask by voice"
            >
              <Mic size={22} />
            </button>
            <span className="muted">{draft.trim() ? "Add more by voice" : "Or tap to speak"}</span>
          </div>
        ) : null}
      </footer>
    </div>,
    document.body,
  );
}

/** iOS scrolls the whole page to make room for the keyboard and doesn't always scroll it back; fixed screens then
 * draw in one place but take taps in another. Put it back once the keyboard is gone. */
function resetIosScroll() {
  setTimeout(() => {
    const focused = document.activeElement;
    if (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement) return;
    if (window.scrollY || window.scrollX) window.scrollTo(0, 0);
  }, 60);
}

// ───────── the panel ─────────

export function AskPanel({
  work,
  queue,
  totalMs,
  positionMs,
  positionNote,
  farthestMs,
  title,
  onClose,
}: {
  work: WorkRef;
  queue: QueueItem[];
  totalMs: number;
  positionMs: number;
  /** Where ``positionMs`` comes from, e.g. "your Audible position". */
  positionNote?: string;
  /** The farthest point you've reached (books: from Audible). Without it, the farthest this device has played. */
  farthestMs?: number;
  title: string;
  /** On phones Ask takes the whole screen; this is its back button. */
  onClose?: () => void;
}) {
  const qc = useQueryClient();
  const player = usePlayer();
  const compact = useMedia(COMPACT_QUERY);
  const screen = compact && !!onClose;
  const overlay = useOverlay();
  const conversations = useQuery({
    queryKey: ["conversations", workQuery(work)],
    queryFn: () => api.get<Conversation[]>(`/transcripts/conversations?${workQuery(work)}`),
  });
  const [activeId, setActiveId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [horizon, setHorizon] = useState<number | null>(null);
  const [scope, setScope] = useState<Scope>(() => {
    const code = Number(stored<number | boolean>(SCOPE_KEY, 0));
    return code === 1 ? "whole" : code === 2 ? "farthest" : "here";
  });
  const wholeWork = scope === "whole";
  const pickScope = (next: Scope) => {
    setScope(next);
    setHorizon(null);
    store(SCOPE_KEY, SCOPE_CODES[next]);
  };
  const [choice, setChoice] = useState<ModelChoice | null>(() => stored<ModelChoice | null>(MODEL_KEY, null));
  const pickModel = useCallback((next: ModelChoice) => {
    setChoice(next);
    store(MODEL_KEY, next);
  }, []);
  const models = useModels("chat");
  const modelLabel = useMemo(() => {
    for (const p of models.data?.providers ?? [])
      if (p.provider === choice?.provider) return p.models.find((m) => m.id === choice?.model)?.label ?? choice?.model;
    return choice?.model ?? "";
  }, [models.data, choice]);
  const grounding = useQuery({
    queryKey: ["ask-grounding"],
    queryFn: () => api.get<{ text: string }>("/transcripts/ask/grounding"),
    staleTime: Infinity,
  });
  const noun = workNoun(work);

  // Without a farthest from the server, remember the farthest this device has played of this work.
  const farKey = FARTHEST_KEY + workQuery(work);
  const [playedFarthest, setPlayedFarthest] = useState(() => stored<number>(farKey, 0));
  const inPlayerIndex = player.current ? queue.findIndex((q) => q.trackId === player.current!.trackId) : -1;
  const playerWorkMs = inPlayerIndex >= 0 ? (queue[inPlayerIndex].workOffsetMs ?? 0) + player.positionMs : -1;
  useEffect(() => {
    if (farthestMs !== undefined || playerWorkMs <= playedFarthest + 1000) return;
    setPlayedFarthest(playerWorkMs);
    store(farKey, Math.round(playerWorkMs));
  }, [farthestMs, playerWorkMs, playedFarthest, farKey]);
  const farthest = Math.max(positionMs, farthestMs ?? playedFarthest);

  const baseHorizon = scope === "farthest" ? farthest : positionMs;
  const effectiveHorizon = horizon ?? baseHorizon;
  const prefix = !wholeWork && grounding.data ? grounding.data.text.split("{position}").join(hms(effectiveHorizon)) : null;
  const scopeLabel = wholeWork ? `Whole ${noun} · spoilers allowed` : `No spoilers past ${clock(effectiveHorizon)}`;
  const baseNote =
    scope === "farthest"
      ? farthestMs !== undefined
        ? "the farthest Audible has reported"
        : "the farthest you've played here"
      : positionNote;
  const placeholder = wholeWork ? `Ask anything about the ${noun}…` : "Ask about what you've heard…";
  const suggestions = suggestionsFor(wholeWork, noun);

  const [dictated, setDictated] = useState(0);
  const dictation = useDictation({
    hint: title,
    onText: (text) => {
      setDraft((d) => (d.trim() ? `${d.trimEnd()} ${text}` : text));
      setDictated((n) => n + 1);
    },
  });

  // Open the latest conversation once on arrival; after that, "New conversation" really means a new one.
  const autoOpened = useRef(false);
  useEffect(() => {
    if (autoOpened.current || !conversations.data) return;
    autoOpened.current = true;
    if (activeId === null && conversations.data.length) setActiveId(conversations.data[0].id);
  }, [conversations.data, activeId]);

  // A conversation created by the question being asked right now: its messages are already on screen.
  const createdRef = useRef<number | null>(null);
  useEffect(() => {
    if (activeId === null) return setMessages([]);
    if (createdRef.current === activeId) return;
    api.get<Conversation>(`/transcripts/conversations/${activeId}`).then((c) => setMessages(c.messages ?? []));
  }, [activeId]);

  // Follow the answer as it streams, unless you've scrolled up to reread something.
  const logRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = logRef.current;
    if (el && stick.current) el.scrollTo({ top: el.scrollHeight, behavior: streaming ? "auto" : "smooth" });
  }, [messages, streaming, busy]);

  const offsets = useMemo(() => queue.map((q) => q.workOffsetMs ?? 0), [queue]);
  const chapterAt = useCallback<ChapterAt>(
    (workMs) => {
      if (queue.length < 2) return null;
      let index = 0;
      for (let i = 0; i < offsets.length; i++) if (offsets[i] <= workMs) index = i;
      const t = queue[index]?.title?.trim();
      return t ? { short: chapterShort(t), title: t } : null;
    },
    [queue, offsets],
  );
  function playAt(workMs: number) {
    let index = 0;
    for (let i = 0; i < offsets.length; i++) if (offsets[i] <= workMs) index = i;
    if (queue[index]) player.play(queue, index, workMs - offsets[index]);
  }

  async function ask(text?: string) {
    const question = (text ?? draft).trim();
    if (!question || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    setDraft("");
    stick.current = true;
    let id = activeId;
    let started = false;
    try {
      if (id === null) {
        const created = await api.post<Conversation>("/transcripts/conversations", work);
        id = created.id;
        createdRef.current = id;
        setActiveId(id);
        qc.invalidateQueries({ queryKey: ["conversations"] });
      }
      const asked = { position_ms: effectiveHorizon, whole_work: wholeWork };
      setMessages((m) => [...m, { id: -1, role: "user", content: question, ...asked, citations: [], model: "", created_at: "" }]);
      started = true;
      let answer = "";
      const body = {
        question,
        position_ms: Math.round(effectiveHorizon),
        whole_work: wholeWork,
        provider: choice?.provider,
        model: choice?.model,
      };
      await streamNdjson(`/transcripts/conversations/${id}/ask`, body, (event) => {
        if (event.type === "text") {
          answer += event.text;
          setStreaming(answer);
        } else if (event.type === "notice") {
          setNotice(event.text);
        } else if (event.type === "error") {
          const failed = { id: -2, role: "error" as const, content: event.error, ...asked, citations: [], model: "", created_at: "" };
          setMessages((m) => [...m, failed]);
        } else if (event.type === "done") {
          setMessages((m) => [
            ...m,
            {
              id: event.message_id,
              role: "assistant",
              content: answer,
              ...asked,
              citations: event.citations,
              provider: event.provider,
              model: event.model,
              created_at: "",
            },
          ]);
        }
      });
    } catch (e) {
      setError(errorText(e));
      if (!started) setDraft(question); // nothing was sent: keep what they wrote
    } finally {
      setStreaming("");
      setBusy(false);
      qc.invalidateQueries({ queryKey: ["conversations"] });
    }
  }

  async function remove(id: number) {
    await api.del(`/transcripts/conversations/${id}`);
    if (activeId === id) setActiveId(null);
    qc.invalidateQueries({ queryKey: ["conversations"] });
  }

  const startNew = () => {
    setActiveId(null);
    setMessages([]);
    setError("");
    setNotice("");
  };

  // iOS only raises the keyboard for a focus inside the tap itself; the composer mounts a moment later, so focus
  // this stand-in field now and the composer's text area takes the focus (and the keyboard) over from it.
  const primer = useRef<HTMLInputElement>(null);
  const [composeByVoice, setComposeByVoice] = useState(false);
  const openCompose = (voice = false) => {
    setComposeByVoice(voice);
    if (voice) void dictation.start();
    else {
      // Blur first: focusing a field that still has the focus doesn't bring the keyboard back.
      primer.current?.blur();
      primer.current?.focus({ preventScroll: true });
    }
    overlay.open("compose");
  };
  // The stand-in field must never keep the focus once the composer is gone, or the next tap can't raise the keyboard.
  useEffect(() => {
    if (overlay.current === "compose") return;
    if (primer.current && document.activeElement === primer.current) primer.current.blur();
    resetIosScroll();
  }, [overlay.current]);
  const closeCompose = () => {
    if (dictation.state === "recording") dictation.cancel();
    overlay.close();
  };
  const sendFromComposer = () => {
    const q = draft;
    overlay.close();
    void ask(q);
  };

  const nothingHeard = !wholeWork && effectiveHorizon < 1000;

  const scopes: [Scope, string][] = [
    ["here", "Up to where I am"],
    ["farthest", "Farthest I've been"],
    ["whole", `Whole ${noun}`],
  ];
  const scopeSwitch = (
    <div className="segmented" role="radiogroup" aria-label="What answers can draw on">
      {scopes.map(([id, label]) => (
        <button key={id} type="button" role="radio" aria-checked={scope === id} className={scope === id ? "active" : ""} onClick={() => pickScope(id)}>
          {label}
        </button>
      ))}
    </div>
  );
  const horizonControls = (
    <>
      {wholeWork ? (
        <div className="horizon-note">
          <Sparkles size={14} color="var(--terracotta)" />
          Spoilers allowed: answers can use the whole {noun}.
        </div>
      ) : (
        <>
          <div className="horizon-note">
            <Lock size={14} color="var(--terracotta)" />
            <span>
              <strong>No spoilers past {clock(effectiveHorizon)}</strong>
              {horizon === null && baseNote && <span className="muted"> · {baseNote}</span>}
            </span>
            <span className="spacer" />
            {horizon !== null && (
              <Button size="sm" variant="ghost" onClick={() => setHorizon(null)}>
                {scope === "farthest" ? "Back to my farthest" : positionNote ? "Back to my Audible position" : "Follow my position"}
              </Button>
            )}
          </div>
          <input
            type="range"
            className="horizon-range"
            min={0}
            max={Math.max(totalMs, 1)}
            step={10000}
            value={effectiveHorizon}
            onChange={(e) => setHorizon(Number(e.target.value))}
            aria-label="Spoiler limit: answers only use the transcript up to here"
          />
        </>
      )}
    </>
  );

  const log = (
    <div
      className="chat-log"
      ref={logRef}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      {!messages.length && !streaming && (
        <div className="ask-empty">
          <Empty icon={<MessageCircle size={34} />} title={`Ask about ${title}`}>
            {wholeWork
              ? `Spoilers allowed: answers draw on the whole ${noun}.`
              : "Answers only use what you've heard so far — never past your position."}
          </Empty>
          {nothingHeard ? (
            <Note tone="info">
              You're at 0:00, so nothing has been heard yet. Move the spoiler limit later, or switch to{" "}
              {scope === "here" && farthest >= 1000 ? <strong>Farthest I've been</strong> : <strong>Whole {noun}</strong>}.
            </Note>
          ) : (
            <div className="ask-suggest">
              {suggestions.map((s) => (
                <button key={s} type="button" className="chip" onClick={() => void ask(s)} disabled={busy}>
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {messages.map((m, i) => (
        <div key={`${m.id}-${i}`} className={`bubble ${m.role}`}>
          {m.role === "assistant" ? renderAnswer(m.content, playAt, chapterAt) : m.role === "error" ? `No answer: ${m.content}` : m.content}
          {m.role === "user" && <div className="bubble-meta">{m.whole_work ? `whole ${noun}` : `up to ${clock(m.position_ms)}`}</div>}
          {m.role === "assistant" && m.model && <div className="bubble-meta">{m.model}</div>}
        </div>
      ))}
      {notice && <Note tone="info">{notice}</Note>}
      {streaming && <div className="bubble assistant">{renderAnswer(streaming, playAt, chapterAt)}</div>}
      {busy && !streaming && (
        <div className="bubble assistant typing" aria-label="Thinking">
          <span />
          <span />
          <span />
        </div>
      )}
      {error && <Note tone="error">{error}</Note>}
    </div>
  );

  // Phones: a pill that opens the full-page composer, with the mic one tap away.
  const trigger = (
    <div className="ask-trigger">
      <input ref={primer} className="kbd-primer" aria-hidden tabIndex={-1} />
      <button type="button" className="ask-pill" onClick={() => openCompose(false)} disabled={busy}>
        {busy ? (
          <>
            <Spinner size={15} /> Answering…
          </>
        ) : draft.trim() ? (
          <span className="truncate ink">{draft}</span>
        ) : (
          <span className="truncate">{placeholder}</span>
        )}
      </button>
      {dictationSupported() && (
        <button type="button" className="round-btn mic" onClick={() => openCompose(true)} disabled={busy} aria-label="Ask by voice">
          <Mic size={20} />
        </button>
      )}
    </div>
  );

  // Desktop: the question box stays inline.
  const inlineInput = (
    <form
      className="chat-input"
      onSubmit={(e) => {
        e.preventDefault();
        void ask();
      }}
    >
      {prefix && <PrefixDisclosure text={prefix} horizonMs={effectiveHorizon} />}
      {dictation.error && <div className="dictation-error">{dictation.error}</div>}
      {dictation.state !== "idle" ? (
        <DictationStrip dictation={dictation} />
      ) : (
        <div className="chat-input-row">
          <AutoGrowTextarea value={draft} onChange={setDraft} onSubmit={() => void ask()} placeholder={placeholder} />
          {dictationSupported() && (
            <Button type="button" iconOnly icon={<Mic size={17} />} onClick={() => void dictation.start()} aria-label="Ask by voice" title="Ask by voice" />
          )}
          <Button variant="primary" type="submit" iconOnly icon={<ArrowUp size={18} strokeWidth={2.4} />} loading={busy} disabled={!draft.trim()} aria-label="Ask" />
        </div>
      )}
    </form>
  );

  const composer = overlay.current === "compose" && (
    <Composer
      draft={draft}
      setDraft={setDraft}
      onSend={sendFromComposer}
      onCancel={closeCompose}
      prefix={prefix}
      horizonMs={effectiveHorizon}
      scopeLabel={scopeLabel}
      placeholder={placeholder}
      suggestions={suggestions}
      dictation={dictation}
      dictated={dictated}
      focusOnOpen={!composeByVoice}
    />
  );

  const conversationList = (
    <div className="ask-convo-list">
      <Button
        icon={<Plus size={16} />}
        onClick={() => {
          startNew();
          if (screen) overlay.close();
        }}
      >
        New conversation
      </Button>
      {(conversations.data ?? []).map((c) => (
        <div
          key={c.id}
          className={`ask-convo ${c.id === activeId ? "active" : ""}`}
          onClick={() => {
            setActiveId(c.id);
            if (screen) overlay.close();
          }}
        >
          <MessageCircle size={15} />
          <span className="ask-convo-text">
            <span className="truncate">{c.title || "New conversation"}</span>
            {screen && <small>{relative(c.updated_at)}</small>}
          </span>
          <button
            className="btn ghost sm icon"
            onClick={(e) => {
              e.stopPropagation();
              if (confirm("Delete this conversation?")) void remove(c.id);
            }}
            aria-label="Delete conversation"
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}
    </div>
  );

  if (screen) {
    const count = conversations.data?.length ?? 0;
    return createPortal(
      <div className="ask-screen">
        <header className="ask-bar">
          <button type="button" className="round-btn ghost" onClick={onClose} aria-label="Back">
            <ChevronLeft size={24} />
          </button>
          <div className="ask-bar-title">
            <small>Ask about</small>
            <b className="truncate">{title}</b>
          </div>
          <button type="button" className="round-btn ghost badge-host" onClick={() => overlay.open("chats")} aria-label="Conversations">
            <MessagesSquare size={20} />
            {count > 1 && <span className="badge">{count}</span>}
          </button>
          <button type="button" className="round-btn ghost" onClick={startNew} aria-label="New conversation" disabled={!messages.length}>
            <SquarePen size={19} />
          </button>
        </header>
        <button type="button" className={`ask-scope ${wholeWork ? "whole" : ""}`} onClick={() => overlay.open("options")}>
          {wholeWork ? <Sparkles size={14} /> : <Lock size={14} />}
          <span className="truncate">
            {scopeLabel}
            {modelLabel && <span className="muted"> · {modelLabel}</span>}
          </span>
          <SlidersHorizontal size={15} className="muted" />
        </button>
        {log}
        <div className="ask-dock">
          <MiniPlayer />
          {trigger}
        </div>
        {composer}
        {overlay.current === "chats" && (
          <Sheet title="Conversations" onClose={overlay.close}>
            {conversationList}
          </Sheet>
        )}
        {overlay.current === "options" && (
          <Sheet title="What answers can use" onClose={overlay.close}>
            <div className="ask-options">
              {scopeSwitch}
              {horizonControls}
              <label className="field">
                <span>Model</span>
                <ModelPicker kind="chat" value={choice} onChange={pickModel} />
              </label>
            </div>
          </Sheet>
        )}
      </div>,
      document.body,
    );
  }

  return (
    <div className="ask-layout">
      <div className="chat">
        <div className="horizon">
          <div className="horizon-top">
            {scopeSwitch}
            <ModelPicker kind="chat" value={choice} onChange={pickModel} compact />
          </div>
          {horizonControls}
        </div>
        {log}
        {compact ? trigger : inlineInput}
      </div>
      <div className="ask-convos">{conversationList}</div>
      {compact && composer}
    </div>
  );
}

function AutoGrowTextarea({
  value,
  onChange,
  onSubmit,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  placeholder: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      rows={1}
      className="input chat-textarea"
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault();
          onSubmit();
        }
      }}
      enterKeyHint="send"
    />
  );
}
