import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Lock, MessageCircle, Plus, Search, Send, Sparkles, Trash2 } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, streamNdjson } from "../api";
import { clock } from "../format";
import { usePlayer, type QueueItem } from "../player";
import type { ChatMessage, Conversation, WorkTranscript } from "../types";
import ModelPicker, { type ModelChoice } from "./ModelPicker";
import { Button, Empty, Note, Spinner, errorText } from "./ui";

const MODEL_KEY = "audio.askModel";
const SCOPE_KEY = "audio.askWholeWork";

function workNoun(work: WorkRef): string {
  return work.episode_id ? "episode" : work.collection_id ? "collection" : "book";
}

export type WorkRef = { book_id?: number; episode_id?: number; collection_id?: number };

function workQuery(work: WorkRef): string {
  return Object.entries(work)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

/** Where the listener is in the work: the player's position if it's playing this work, else a fallback. */
export function useWorkPosition(queue: QueueItem[], fallbackMs: number): number {
  const player = usePlayer();
  const inThisWork = player.current && queue.some((q) => q.trackId === player.current!.trackId);
  if (inThisWork) return (player.current!.workOffsetMs ?? 0) + player.positionMs;
  return fallbackMs;
}

export function TranscriptView({ work, queue, positionMs }: { work: WorkRef; queue: QueueItem[]; positionMs: number }) {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const player = usePlayer();
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(q), 250);
    return () => window.clearTimeout(id);
  }, [q]);
  const data = useQuery({
    queryKey: ["transcript", workQuery(work), debounced],
    queryFn: () => api.get<WorkTranscript>(`/transcripts/work?${workQuery(work)}&q=${encodeURIComponent(debounced)}`),
  });
  const currentRef = useRef<HTMLDivElement>(null);

  function jump(trackId: number, trackStartMs: number) {
    const index = queue.findIndex((x) => x.trackId === trackId);
    if (index >= 0) player.play(queue, index, trackStartMs);
  }

  if (data.isLoading) return <Spinner />;
  if (data.isError) return <Note tone="error">{errorText(data.error)}</Note>;
  const t = data.data!;
  if (!t.transcribed)
    return (
      <Empty icon={<FileText size={36} />} title="No transcript yet">
        Transcribe this to search it, follow along, and ask questions about it.
      </Empty>
    );

  const currentIndex = t.segments.findIndex((s, i) => s.start_ms <= positionMs && (t.segments[i + 1]?.start_ms ?? Infinity) > positionMs);
  const pattern = debounced ? new RegExp(`(${debounced.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi") : null;

  return (
    <div className="stack" style={{ "--gap": "14px" } as React.CSSProperties}>
      <div className="row wrap">
        <div className="search" style={{ flex: 1 }}>
          <Search size={17} />
          <input className="input" placeholder="Search the transcript…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <span className="muted" style={{ fontSize: "var(--text-sm)" }}>
          {t.transcribed}/{t.tracks.length} transcribed{debounced && ` · ${t.segments.length} matches`}
        </span>
        {!debounced && currentIndex >= 0 && (
          <Button size="sm" onClick={() => currentRef.current?.scrollIntoView({ behavior: "smooth", block: "center" })}>
            Jump to {clock(positionMs)}
          </Button>
        )}
      </div>
      <div className="transcript">
        {t.segments.map((s, i) => {
          const header = i === 0 || t.segments[i - 1].track_id !== s.track_id;
          return (
            <Fragment key={`${s.track_id}-${s.start_ms}-${i}`}>
              {header && !debounced && <div className="seg-chapter">{s.track_title}</div>}
              <div
                ref={i === currentIndex ? currentRef : undefined}
                className={`seg ${i === currentIndex ? "current" : ""} ${!debounced && s.start_ms > positionMs ? "ahead" : ""}`}
              >
                <time onClick={() => jump(s.track_id, s.track_start_ms)} title="Play from here">
                  {clock(s.start_ms)}
                </time>
                <span>
                  {debounced && <span className="muted" style={{ fontSize: "var(--text-xs)", marginRight: 6 }}>{s.track_title} ·</span>}
                  {pattern ? s.text.split(pattern).map((part, k) => (k % 2 ? <mark key={k}>{part}</mark> : part)) : s.text}
                </span>
              </div>
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

/** h:mm:ss, the way the server writes the spoiler limit into the grounding warning. */
function hms(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function renderAnswer(text: string, onCite: (ms: number) => void): ReactNode[] {
  return text.split(/(\[\d+:\d{2}:\d{2}\])/g).map((part, i) => {
    const m = part.match(/^\[(\d+):(\d{2}):(\d{2})\]$/);
    if (!m) return part;
    const ms = (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000;
    return (
      <button key={i} className="cite" onClick={() => onCite(ms)} title="Play from here">
        {m[1] === "0" ? `${m[2]}:${m[3]}` : `${m[1]}:${m[2]}:${m[3]}`}
      </button>
    );
  });
}

export function AskPanel({
  work,
  queue,
  totalMs,
  positionMs,
  positionNote,
  title,
}: {
  work: WorkRef;
  queue: QueueItem[];
  totalMs: number;
  positionMs: number;
  /** Where ``positionMs`` comes from, e.g. "your Audible position". */
  positionNote?: string;
  title: string;
}) {
  const qc = useQueryClient();
  const player = usePlayer();
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
  const [horizon, setHorizon] = useState<number | null>(null);
  const [wholeWork, setWholeWork] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SCOPE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const pickScope = (whole: boolean) => {
    setWholeWork(whole);
    try {
      localStorage.setItem(SCOPE_KEY, whole ? "1" : "0");
    } catch {
      /* storage unavailable */
    }
  };
  const noun = workNoun(work);
  const [notice, setNotice] = useState("");
  const [choice, setChoice] = useState<ModelChoice | null>(() => {
    try {
      return JSON.parse(localStorage.getItem(MODEL_KEY) || "null");
    } catch {
      return null;
    }
  });
  const pickModel = useCallback((next: ModelChoice) => {
    setChoice(next);
    try {
      localStorage.setItem(MODEL_KEY, JSON.stringify(next));
    } catch {
      /* storage unavailable */
    }
  }, []);
  const grounding = useQuery({
    queryKey: ["ask-grounding"],
    queryFn: () => api.get<{ text: string }>("/transcripts/ask/grounding"),
    staleTime: Infinity,
  });
  const logRef = useRef<HTMLDivElement>(null);
  const effectiveHorizon = horizon ?? positionMs;

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

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, streaming]);

  const offsets = useMemo(() => queue.map((q) => q.workOffsetMs ?? 0), [queue]);

  function playAt(workMs: number) {
    let index = 0;
    for (let i = 0; i < offsets.length; i++) if (offsets[i] <= workMs) index = i;
    if (queue[index]) player.play(queue, index, workMs - offsets[index]);
  }

  async function ask() {
    const question = draft.trim();
    if (!question || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    setDraft("");
    let id = activeId;
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

  const nothingHeard = !wholeWork && effectiveHorizon < 1000;

  return (
    <div className="ask-layout">
      <div className="chat">
        <div className="horizon">
          <div className="horizon-top">
            <div className="segmented" role="radiogroup" aria-label="What answers can draw on">
              <button role="radio" aria-checked={!wholeWork} className={!wholeWork ? "active" : ""} onClick={() => pickScope(false)}>
                Up to where I am
              </button>
              <button role="radio" aria-checked={wholeWork} className={wholeWork ? "active" : ""} onClick={() => pickScope(true)}>
                Whole {noun}
              </button>
            </div>
            <ModelPicker kind="chat" value={choice} onChange={pickModel} compact />
          </div>
          {wholeWork ? (
            <div className="horizon-note">
              <Sparkles size={14} color="var(--terracotta)" />
              Spoilers allowed: answers can use the whole {noun}.
            </div>
          ) : (
            <>
              <div className="horizon-note">
                <Sparkles size={14} color="var(--terracotta)" />
                <span>
                  <strong>No spoilers past {clock(effectiveHorizon)}</strong>
                  {horizon === null && positionNote && <span className="muted"> · {positionNote}</span>}
                </span>
                <span className="spacer" />
                {horizon !== null && (
                  <Button size="sm" variant="ghost" onClick={() => setHorizon(null)}>
                    {positionNote ? "Back to my Audible position" : "Follow my position"}
                  </Button>
                )}
              </div>
              <input
                type="range"
                min={0}
                max={Math.max(totalMs, 1)}
                step={10000}
                value={effectiveHorizon}
                onChange={(e) => setHorizon(Number(e.target.value))}
                aria-label="Spoiler limit: answers only use the transcript up to here"
              />
            </>
          )}
        </div>
        <div className="chat-log" ref={logRef}>
          {!messages.length && !streaming && (
            <Empty icon={<MessageCircle size={34} />} title={`Ask about ${title}`}>
              {wholeWork
                ? `“How does it end?” “What becomes of the main character?” Spoilers allowed: answers draw on the whole ${noun}.`
                : "“Who is Mr. Craven again?” “What just happened in this chapter?” “Remind me why they left?” — no spoilers past your position."}
            </Empty>
          )}
          {nothingHeard && !messages.length && (
            <Note tone="info">
              You're at 0:00, so nothing has been heard yet. Drag the spoiler limit later, or switch to <strong>Whole {noun}</strong>.
            </Note>
          )}
          {messages.map((m, i) => (
            <div key={`${m.id}-${i}`} className={`bubble ${m.role}`}>
              {m.role === "assistant" ? renderAnswer(m.content, playAt) : m.role === "error" ? `No answer: ${m.content}` : m.content}
              {m.role === "user" && (
                <div className="bubble-meta" style={{ color: "rgb(255 248 241 / 0.7)" }}>
                  {m.whole_work ? `whole ${noun}` : `up to ${clock(m.position_ms)}`}
                </div>
              )}
              {m.role === "assistant" && m.model && <div className="bubble-meta">{m.model}</div>}
            </div>
          ))}
          {notice && <Note tone="info">{notice}</Note>}
          {streaming && <div className="bubble assistant">{renderAnswer(streaming, playAt)}</div>}
          {busy && !streaming && (
            <div className="bubble assistant">
              <Spinner size={16} />
            </div>
          )}
          {error && <Note tone="error">{error}</Note>}
        </div>
        <form
          className="chat-input"
          onSubmit={(e) => {
            e.preventDefault();
            ask();
          }}
        >
          {!wholeWork && grounding.data && (
            <div className="ask-prefix" aria-label="Sent before your question; can't be edited">
              <Lock size={12} />
              <span>{grounding.data.text.split("{position}").join(hms(effectiveHorizon))}</span>
            </div>
          )}
          <input
            className="input"
            placeholder={wholeWork ? `Ask anything about the ${noun}…` : "Ask about what you've heard…"}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            enterKeyHint="send"
          />
          <Button variant="primary" type="submit" iconOnly icon={<Send size={17} />} loading={busy} aria-label="Ask" />
        </form>
      </div>
      <div className="ask-convos">
        <Button icon={<Plus size={16} />} onClick={() => (setActiveId(null), setMessages([]))}>
          New conversation
        </Button>
        {(conversations.data ?? []).map((c) => (
          <div key={c.id} className={`ask-convo ${c.id === activeId ? "active" : ""}`} onClick={() => setActiveId(c.id)}>
            <MessageCircle size={14} />
            <span className="truncate" style={{ flex: 1, fontSize: "var(--text-sm)" }}>
              {c.title || "New conversation"}
            </span>
            <button
              className="btn ghost sm icon"
              onClick={(e) => {
                e.stopPropagation();
                remove(c.id);
              }}
              aria-label="Delete conversation"
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
