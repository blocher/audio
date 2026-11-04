import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, MessageCircle, Plus, Search, Send, Sparkles, Trash2 } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, streamNdjson } from "../api";
import { clock } from "../format";
import { usePlayer, type QueueItem } from "../player";
import type { ChatMessage, Conversation, WorkTranscript } from "../types";
import ModelPicker, { type ModelChoice } from "./ModelPicker";
import { Button, Empty, Note, Spinner, errorText } from "./ui";

const MODEL_KEY = "audio.askModel";

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
  title,
}: {
  work: WorkRef;
  queue: QueueItem[];
  totalMs: number;
  positionMs: number;
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
  const logRef = useRef<HTMLDivElement>(null);
  const effectiveHorizon = horizon ?? positionMs;

  useEffect(() => {
    if (activeId === null && conversations.data?.length) setActiveId(conversations.data[0].id);
  }, [conversations.data, activeId]);

  useEffect(() => {
    if (activeId === null) return setMessages([]);
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
        setActiveId(id);
        qc.invalidateQueries({ queryKey: ["conversations"] });
      }
      setMessages((m) => [...m, { id: -1, role: "user", content: question, position_ms: effectiveHorizon, citations: [], model: "", created_at: "" }]);
      let answer = "";
      const body = { question, position_ms: Math.round(effectiveHorizon), provider: choice?.provider, model: choice?.model };
      await streamNdjson(`/transcripts/conversations/${id}/ask`, body, (event) => {
        if (event.type === "text") {
          answer += event.text;
          setStreaming(answer);
        } else if (event.type === "notice") {
          setNotice(event.text);
        } else if (event.type === "error") {
          setError(event.error);
        } else if (event.type === "done") {
          setMessages((m) => [
            ...m,
            {
              id: event.message_id,
              role: "assistant",
              content: answer,
              position_ms: effectiveHorizon,
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

  return (
    <div className="with-rail" style={{ gridTemplateColumns: "minmax(0,1fr) 260px" }}>
      <div className="chat">
        <div className="horizon">
          <div className="row wrap">
            <Sparkles size={16} color="var(--terracotta)" />
            <strong style={{ fontSize: "var(--text-sm)" }}>Spoiler horizon: {clock(effectiveHorizon)}</strong>
            <span className="muted" style={{ fontSize: "var(--text-xs)" }}>
              Answers only use what's been heard up to here.
            </span>
            <span className="spacer" />
            {horizon !== null && (
              <Button size="sm" variant="ghost" onClick={() => setHorizon(null)}>
                Follow my position
              </Button>
            )}
            <ModelPicker kind="chat" value={choice} onChange={pickModel} compact />
          </div>
          <input
            type="range"
            min={0}
            max={Math.max(totalMs, 1)}
            step={10000}
            value={effectiveHorizon}
            onChange={(e) => setHorizon(Number(e.target.value))}
            aria-label="Listening position for answers"
          />
        </div>
        <div className="chat-log" ref={logRef}>
          {!messages.length && !streaming && (
            <Empty icon={<MessageCircle size={34} />} title={`Ask about ${title}`}>
              “Who is Mr. Craven again?” “What just happened in this chapter?” “Remind me why they left?” — no spoilers past your
              position.
            </Empty>
          )}
          {messages.map((m, i) => (
            <div key={`${m.id}-${i}`} className={`bubble ${m.role}`}>
              {m.role === "assistant" ? renderAnswer(m.content, playAt) : m.content}
              {m.role === "user" && <div className="bubble-meta" style={{ color: "rgb(255 248 241 / 0.7)" }}>at {clock(m.position_ms)}</div>}
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
          <input className="input" placeholder="Ask a question about what you've heard…" value={draft} onChange={(e) => setDraft(e.target.value)} />
          <Button variant="primary" type="submit" iconOnly icon={<Send size={17} />} loading={busy} aria-label="Ask" />
        </form>
      </div>
      <div className="stack">
        <Button icon={<Plus size={16} />} onClick={() => (setActiveId(null), setMessages([]))}>
          New conversation
        </Button>
        {(conversations.data ?? []).map((c) => (
          <div
            key={c.id}
            className="row"
            style={{
              padding: "8px 10px",
              borderRadius: 8,
              background: c.id === activeId ? "var(--paper-sunk)" : undefined,
              cursor: "pointer",
            }}
            onClick={() => setActiveId(c.id)}
          >
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
