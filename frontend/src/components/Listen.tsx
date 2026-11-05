import { useQuery } from "@tanstack/react-query";
import { FileText, Search } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { clock } from "../format";
import { usePlayer, type QueueItem } from "../player";
import type { WorkTranscript } from "../types";
import { Button, Empty, Note, Spinner, errorText } from "./ui";

export function workNoun(work: WorkRef): string {
  return work.episode_id ? "episode" : work.collection_id ? "collection" : "book";
}

export type WorkRef = { book_id?: number; episode_id?: number; collection_id?: number };

export function workQuery(work: WorkRef): string {
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
