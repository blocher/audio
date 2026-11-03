import { CheckCircle2, FileText, Pause, Play } from "lucide-react";
import { clock, duration, bytes } from "../format";
import { usePlayer, type QueueItem } from "../player";
import type { Track } from "../types";

/** Player queue for a work. Book chapters know their offset in the book; other tracks are laid end to end. */
export function queueFor(tracks: Track[], meta: { subtitle: string; cover?: string; link?: string }): QueueItem[] {
  let cursor = 0;
  const out: QueueItem[] = [];
  for (const t of tracks) {
    const offset = t.source === "book" ? t.start_ms : cursor;
    cursor = offset + t.duration_ms;
    if (!t.stream_url) continue;
    out.push({ trackId: t.id, title: t.title, subtitle: meta.subtitle, cover: meta.cover, link: meta.link, src: t.stream_url, workOffsetMs: offset });
  }
  return out;
}

export function TrackStatus({ track }: { track: Track }) {
  return (
    <>
      {track.has_optimized ? (
        <span className="pill sage" title={`Downsized from ${bytes(track.size_bytes)}`}>
          {track.optimized_bitrate_kbps}k {track.optimized_mono ? "mono" : "stereo"} · {bytes(track.optimized_size_bytes)}
        </span>
      ) : track.has_file ? (
        <span className="pill">{bytes(track.size_bytes)}</span>
      ) : null}
      {track.transcript_status === "ready" && (
        <span className="pill sky">
          <FileText size={11} /> Transcript
        </span>
      )}
      {(track.transcript_status === "running" || track.transcript_status === "queued") && <span className="pill honey">Transcribing…</span>}
      {track.transcript_status === "failed" && <span className="pill berry">Transcript failed</span>}
    </>
  );
}

export default function TrackList({
  tracks,
  meta,
  selected,
  onToggle,
  numbered = true,
}: {
  tracks: Track[];
  meta: { subtitle: string; cover?: string; link?: string };
  selected?: Set<number>;
  onToggle?: (id: number) => void;
  numbered?: boolean;
}) {
  const player = usePlayer();
  const queue = queueFor(tracks, meta);
  return (
    <div className="list">
      {tracks.map((t, n) => {
        const isCurrent = player.current?.trackId === t.id;
        const queueIndex = queue.findIndex((q) => q.trackId === t.id);
        return (
          <div key={t.id} className={`list-row ${isCurrent ? "playing" : ""}`}>
            <div className="row" style={{ "--gap": "10px" } as React.CSSProperties}>
              {onToggle && (
                <input
                  type="checkbox"
                  className="check"
                  checked={selected?.has(t.id) ?? false}
                  onChange={() => onToggle(t.id)}
                  aria-label={`Select ${t.title}`}
                  style={{ accentColor: "var(--terracotta)", width: 16, height: 16 }}
                />
              )}
              {numbered && <span className="num">{n + 1}</span>}
              <button
                className="play-dot"
                disabled={queueIndex < 0}
                onClick={() => (isCurrent ? player.toggle() : player.play(queue, queueIndex))}
                aria-label={isCurrent && player.playing ? "Pause" : `Play ${t.title}`}
              >
                {isCurrent && player.playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" style={{ marginLeft: 2 }} />}
              </button>
            </div>
            <div style={{ minWidth: 0 }}>
              <div className="title truncate">{t.title}</div>
              <div className="sub">
                <span className="tabular">{t.start_ms ? `starts ${clock(t.start_ms)} · ` : ""}{duration(t.duration_ms)}</span>
                <TrackStatus track={t} />
              </div>
            </div>
            <div className="actions">{isCurrent && <CheckCircle2 size={16} color="var(--terracotta)" />}</div>
          </div>
        );
      })}
    </div>
  );
}
