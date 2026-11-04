import { useQuery } from "@tanstack/react-query";
import { Check, CheckCircle2, Folder, Mic, SquareStack } from "lucide-react";
import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { bytes, duration } from "../format";
import { useStars, type StarKind } from "../hooks/stars";
import { usePlayer } from "../player";
import type { Book, Collection, Playlist, Podcast } from "../types";
import { StarButton } from "./StarButton";
import { Button, Cover, Meter, Progress, SourceIcon, Spinner } from "./ui";

export interface LibraryItem {
  key: string;
  kind: StarKind;
  id: number;
  title: string;
  by: string;
  cover: string;
  to: string;
  accountId?: number;
  progress?: number;
  meta: string;
  source: string;
  ready?: boolean;
  transcribed?: boolean;
  inProgress?: boolean;
  finished?: boolean;
  sortDate: string;
  /** When the signed-in user starred it; undefined when they haven't. */
  starredAt?: string;
}

/** Every book, podcast and folder as one list of cards, with the signed-in user's stars. */
export function useLibraryItems() {
  const books = useQuery({
    queryKey: ["books"],
    queryFn: () => api.get<Book[]>("/audible/books"),
  });
  const podcasts = useQuery({
    queryKey: ["podcasts"],
    queryFn: () => api.get<Podcast[]>("/podcasts"),
  });
  const folders = useQuery({
    queryKey: ["collections"],
    queryFn: () => api.get<Collection[]>("/local/collections"),
  });
  const stars = useStars();

  const items = useMemo<LibraryItem[]>(() => {
    const out: LibraryItem[] = [];
    for (const b of books.data ?? [])
      out.push({
        key: `b${b.id}`,
        kind: "book",
        id: b.id,
        title: b.title,
        by: b.authors,
        cover: b.cover_url,
        to: `/books/${b.id}`,
        accountId: b.account_id,
        progress: b.is_finished ? 1 : b.percent_complete / 100,
        meta: duration(b.runtime_min * 60000),
        source: `Audible · ${b.account_name}`,
        ready: b.status === "ready",
        transcribed: b.transcribed_count > 0,
        inProgress: b.percent_complete > 0 && !b.is_finished,
        finished: b.is_finished,
        sortDate: b.purchase_date ?? "",
      });
    for (const p of podcasts.data ?? [])
      out.push({
        key: `p${p.id}`,
        kind: "podcast",
        id: p.id,
        title: p.title,
        by: p.author,
        cover: p.image_url,
        to: `/podcasts/${p.id}`,
        progress: p.episode_count ? p.downloaded_count / p.episode_count : 0,
        meta: `${p.downloaded_count} of ${p.episode_count} saved`,
        source: "Podcast",
        ready: p.downloaded_count > 0,
        transcribed: p.transcribed_count > 0,
        sortDate: p.last_refreshed_at ?? "",
      });
    for (const c of folders.data ?? [])
      out.push({
        key: `c${c.id}`,
        kind: "folder",
        id: c.id,
        title: c.name,
        by: `${c.track_count} files`,
        cover: "",
        to: `/folders/${c.id}`,
        meta: duration(c.total_duration_ms),
        source: "Local folder",
        ready: c.mp3_count > 0,
        transcribed: c.transcribed_count > 0,
        sortDate: c.created_at,
      });
    for (const item of out) item.starredAt = stars.starredAt(item.kind, item.id);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [books.data, podcasts.data, folders.data, stars.data]);

  return {
    items,
    books: books.data ?? [],
    podcasts: podcasts.data ?? [],
    folders: folders.data ?? [],
    loading: books.isLoading || podcasts.isLoading || folders.isLoading,
  };
}

export function CoverGrid({ items }: { items: LibraryItem[] }) {
  return (
    <div className="cover-grid">
      {items.map((item) => (
        <Link key={item.key} to={item.to} className="cover-card">
          <div style={{ position: "relative" }}>
            {item.kind === "folder" ? (
              <div className="cover">
                <div
                  className="fallback"
                  style={{
                    background: "linear-gradient(150deg, var(--sage-soft), var(--paper-edge))",
                  }}
                >
                  <Folder size={42} strokeWidth={1.3} />
                </div>
              </div>
            ) : (
              <Cover src={item.cover} title={item.title} />
            )}
            <StarButton kind={item.kind} id={item.id} title={item.title} overlay />
            {item.ready && (
              <span className="pill solid" style={{ position: "absolute", top: 8, right: 8 }}>
                <CheckCircle2 size={12} /> MP3
              </span>
            )}
          </div>
          <div className="cover-title">{item.title}</div>
          <div className="cover-meta">
            {item.kind === "book" ? (
              <SourceIcon kind="audible" />
            ) : item.kind === "podcast" ? (
              <Mic size={13} />
            ) : (
              <Folder size={13} />
            )}
            <span className="truncate">{item.kind === "book" ? item.by || item.source : item.source}</span>
          </div>
          {item.progress !== undefined && (
            <div className="row" style={{ "--gap": "8px" } as React.CSSProperties}>
              <div style={{ flex: 1 }}>
                <Progress value={item.progress} />
              </div>
              <span className="muted tabular" style={{ fontSize: "var(--text-xs)" }}>
                {item.kind === "book" ? `${Math.round((item.progress ?? 0) * 100)}%` : item.meta}
              </span>
            </div>
          )}
        </Link>
      ))}
    </div>
  );
}

export function GridSkeleton({ count = 10 }: { count?: number }) {
  return (
    <div className="cover-grid">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="stack">
          <div className="skeleton" style={{ aspectRatio: "1" }} />
          <div className="skeleton" style={{ height: 16, width: "70%" }} />
        </div>
      ))}
    </div>
  );
}

export function ContinueListening() {
  const p = usePlayer();
  if (!p.current) return null;
  return (
    <div className="panel">
      <div className="eyebrow" style={{ marginBottom: 10 }}>
        Continue listening
      </div>
      <div className="row" style={{ "--gap": "14px", alignItems: "flex-start" } as React.CSSProperties}>
        {p.current.cover && (
          <img
            src={p.current.cover}
            alt=""
            style={{
              width: 64,
              height: 64,
              borderRadius: 8,
              objectFit: "cover",
            }}
          />
        )}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="serif" style={{ fontWeight: 600, fontSize: "var(--text-lg)" }}>
            {p.current.subtitle}
          </div>
          <div className="muted truncate" style={{ fontSize: "var(--text-sm)" }}>
            {p.current.title}
          </div>
          <div style={{ marginTop: 10 }}>
            <Progress value={p.durationMs ? p.positionMs / p.durationMs : 0} tone="terracotta" />
          </div>
        </div>
      </div>
      <Button variant="primary" style={{ width: "100%", marginTop: 14 }} onClick={p.toggle}>
        {p.playing ? "Pause" : "Resume"}
      </Button>
    </div>
  );
}

export function YotoRail({ playlists, loading }: { playlists: Playlist[]; loading: boolean }) {
  const recent = playlists.slice(0, 3);
  const limit = 500 * 1024 * 1024;
  return (
    <div className="panel">
      <div className="panel-head">
        <h3>Ready for little ears</h3>
        <SquareStack size={20} color="var(--terracotta)" />
      </div>
      {loading ? (
        <Spinner />
      ) : recent.length ? (
        <div className="stack" style={{ "--gap": "14px" } as React.CSSProperties}>
          {recent.map((p) => (
            <Link
              key={p.id}
              to={`/yoto/playlists/${p.id}`}
              className="row"
              style={{ "--gap": "12px", alignItems: "center" } as React.CSSProperties}
            >
              <div className="card-art" style={{ width: 46 }}>
                {p.cover_url ? <img src={p.cover_url} alt="" /> : "♪"}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="truncate" style={{ fontWeight: 600 }}>
                  {p.title}
                </div>
                <div className="muted tabular" style={{ fontSize: "var(--text-xs)", margin: "2px 0 6px" }}>
                  {duration(p.total_duration_ms)} · {bytes(p.total_bytes)} · {p.status === "synced" ? "on Yoto" : p.status}
                </div>
                <Meter value={Math.max(p.total_bytes / limit, p.total_duration_ms / (5 * 3600 * 1000))} />
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
          Turn any book, podcast or folder into Yoto cards — packed to fit as much as possible on each one.
        </p>
      )}
      <Link to="/yoto" className="btn sage" style={{ width: "100%", marginTop: 16 }}>
        <SquareStack size={17} /> Plan Yoto cards
      </Link>
    </div>
  );
}

export interface Filter<T> {
  key: string;
  label: string;
  icon: React.ReactNode;
  test: (row: T) => boolean;
}

/** Toggle chips that narrow a list; each one's state lives in the URL (?starred=1). */
export function useFilters<T>(filters: Filter<T>[], rows: T[]) {
  const [params, setParams] = useSearchParams();
  const active = filters.filter((f) => params.get(f.key) === "1");
  const toggle = (key: string) => {
    const next = new URLSearchParams(params);
    if (next.get(key) === "1") next.delete(key);
    else next.set(key, "1");
    setParams(next, { replace: true });
  };
  const chips = (
    <div className="chips filter-chips" role="group" aria-label="Filter">
      {filters.map((f) => {
        const on = active.includes(f);
        return (
          <button key={f.key} className={`chip toggle ${on ? "active" : ""}`} aria-pressed={on} onClick={() => toggle(f.key)}>
            {on ? <Check size={15} /> : f.icon}
            {f.label} <span className="n">{rows.filter(f.test).length}</span>
          </button>
        );
      })}
    </div>
  );
  return {
    shown: rows.filter((r) => active.every((f) => f.test(r))),
    chips,
    filtering: active.length > 0,
  };
}
