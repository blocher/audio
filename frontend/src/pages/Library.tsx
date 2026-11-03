import { useQuery } from "@tanstack/react-query";
import { BookOpen, CheckCircle2, Folder, Headphones, Mic, Plus, RefreshCw, Search, SquareStack } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { Button, Cover, Empty, Meter, PageHead, Progress, SourceIcon, Spinner, useToast } from "../components/ui";
import { bytes, duration, relative } from "../format";
import { useAction } from "../hooks/queries";
import { usePlayer } from "../player";
import type { AudibleAccount, Book, Collection, Playlist, Podcast } from "../types";

type Kind = "all" | "books" | "podcasts" | "local";

interface Item {
  key: string;
  kind: "book" | "podcast" | "local";
  title: string;
  by: string;
  cover: string;
  to: string;
  progress?: number;
  meta: string;
  source: string;
  ready?: boolean;
  sortDate: string;
}

export default function Library() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const kind = (params.get("kind") as Kind) || "all";
  const accountId = params.get("account");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"recent" | "title" | "progress">("recent");

  const accounts = useQuery({ queryKey: ["audible-accounts"], queryFn: () => api.get<AudibleAccount[]>("/audible/accounts") });
  const books = useQuery({ queryKey: ["books"], queryFn: () => api.get<Book[]>("/audible/books") });
  const podcasts = useQuery({ queryKey: ["podcasts"], queryFn: () => api.get<Podcast[]>("/podcasts") });
  const folders = useQuery({ queryKey: ["collections"], queryFn: () => api.get<Collection[]>("/local/collections") });
  const playlists = useQuery({ queryKey: ["playlists"], queryFn: () => api.get<Playlist[]>("/yoto/playlists") });
  const sync = useAction((id: number) => api.post(`/audible/accounts/${id}/sync`), [["books"]]);

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    for (const b of books.data ?? []) {
      if (accountId && String(b.account_id) !== accountId) continue;
      out.push({
        key: `b${b.id}`,
        kind: "book",
        title: b.title,
        by: b.authors,
        cover: b.cover_url,
        to: `/books/${b.id}`,
        progress: b.is_finished ? 1 : b.percent_complete / 100,
        meta: duration(b.runtime_min * 60000),
        source: `Audible · ${b.account_name}`,
        ready: b.status === "ready",
        sortDate: b.purchase_date ?? "",
      });
    }
    if (!accountId) {
      for (const p of podcasts.data ?? [])
        out.push({
          key: `p${p.id}`,
          kind: "podcast",
          title: p.title,
          by: p.author,
          cover: p.image_url,
          to: `/podcasts/${p.id}`,
          progress: p.episode_count ? p.downloaded_count / p.episode_count : 0,
          meta: `${p.downloaded_count} of ${p.episode_count} saved`,
          source: "Podcast",
          sortDate: p.last_refreshed_at ?? "",
        });
      for (const c of folders.data ?? [])
        out.push({
          key: `c${c.id}`,
          kind: "local",
          title: c.name,
          by: `${c.track_count} files`,
          cover: "",
          to: `/folders/${c.id}`,
          meta: duration(c.total_duration_ms),
          source: "Local folder",
          sortDate: c.created_at,
        });
    }
    const needle = q.trim().toLowerCase();
    const kindMap: Record<Kind, Item["kind"] | null> = { all: null, books: "book", podcasts: "podcast", local: "local" };
    const filtered = out.filter(
      (i) => (!kindMap[kind] || i.kind === kindMap[kind]) && (!needle || `${i.title} ${i.by}`.toLowerCase().includes(needle)),
    );
    filtered.sort((a, b) =>
      sort === "title"
        ? a.title.localeCompare(b.title)
        : sort === "progress"
          ? (b.progress ?? 0) - (a.progress ?? 0)
          : b.sortDate.localeCompare(a.sortDate),
    );
    return filtered;
  }, [books.data, podcasts.data, folders.data, kind, q, sort, accountId]);

  const counts = {
    all: (books.data?.length ?? 0) + (podcasts.data?.length ?? 0) + (folders.data?.length ?? 0),
    books: books.data?.length ?? 0,
    podcasts: podcasts.data?.length ?? 0,
    local: folders.data?.length ?? 0,
  };
  const loading = books.isLoading || podcasts.isLoading || folders.isLoading;
  const account = accounts.data?.find((a) => String(a.id) === accountId);
  const setKind = (k: Kind) => {
    const next = new URLSearchParams(params);
    if (k === "all") next.delete("kind");
    else next.set("kind", k);
    setParams(next);
  };

  return (
    <>
      <PageHead
        title={account ? `${account.name}'s library` : "Your listening library"}
        lede={account ? `${account.book_count} titles on Audible · synced ${relative(account.last_synced_at)}` : "Good stories, all in one place."}
        actions={
          <>
            <div className="search">
              <Search size={17} />
              <input className="input" placeholder="Search your audio…" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            {account ? (
              <Button
                icon={<RefreshCw size={16} />}
                loading={sync.isPending}
                onClick={() => sync.mutate(account.id, { onSuccess: () => toast("Syncing library from Audible…") })}
              >
                Sync
              </Button>
            ) : null}
            <Button variant="primary" icon={<Plus size={18} />} onClick={() => navigate("/settings#sources")}>
              Add audio
            </Button>
          </>
        }
      />

      <div className="with-rail">
        <section>
          <div className="toolbar">
            <div className="chips">
              {(
                [
                  ["all", "All audio", null],
                  ["books", "Audiobooks", <BookOpen size={16} key="b" />],
                  ["podcasts", "Podcasts", <Mic size={16} key="p" />],
                  ["local", "Local files", <Folder size={16} key="l" />],
                ] as const
              ).map(([k, label, icon]) => (
                <button key={k} className={`chip ${kind === k ? "active" : ""}`} onClick={() => setKind(k)}>
                  {icon}
                  {label} <span className="n">{counts[k]}</span>
                </button>
              ))}
            </div>
            <span className="spacer" />
            <div className="segmented" role="group" aria-label="Sort">
              {(["recent", "title", "progress"] as const).map((s) => (
                <button key={s} className={sort === s ? "active" : ""} onClick={() => setSort(s)}>
                  {s === "recent" ? "Recent" : s === "title" ? "A–Z" : "In progress"}
                </button>
              ))}
            </div>
          </div>

          {loading ? (
            <div className="cover-grid">
              {Array.from({ length: 10 }).map((_, i) => (
                <div key={i} className="stack">
                  <div className="skeleton" style={{ aspectRatio: "1" }} />
                  <div className="skeleton" style={{ height: 16, width: "70%" }} />
                </div>
              ))}
            </div>
          ) : items.length ? (
            <div className="cover-grid">
              {items.map((item) => (
                <Link key={item.key} to={item.to} className="cover-card">
                  <div style={{ position: "relative" }}>
                    {item.kind === "local" ? (
                      <div className="cover">
                        <div className="fallback" style={{ background: "linear-gradient(150deg, var(--sage-soft), var(--paper-edge))" }}>
                          <Folder size={42} strokeWidth={1.3} />
                        </div>
                      </div>
                    ) : (
                      <Cover src={item.cover} title={item.title} />
                    )}
                    {item.ready && (
                      <span className="pill solid" style={{ position: "absolute", top: 8, right: 8 }}>
                        <CheckCircle2 size={12} /> MP3
                      </span>
                    )}
                  </div>
                  <div className="cover-title">{item.title}</div>
                  <div className="cover-meta">
                    {item.kind === "book" ? <SourceIcon kind="audible" /> : item.kind === "podcast" ? <Mic size={13} /> : <Folder size={13} />}
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
          ) : counts.all ? (
            <Empty icon={<Search size={34} />} title="Nothing matches">
              Try a different search or filter.
            </Empty>
          ) : (
            <Empty
              icon={<Headphones size={40} />}
              title="Your library is empty"
              action={
                <Button variant="primary" onClick={() => navigate("/settings#sources")} icon={<Plus size={18} />}>
                  Connect Audible or add a podcast
                </Button>
              }
            >
              Connect an Audible account, subscribe to a podcast, or import a folder of audio to get started.
            </Empty>
          )}
        </section>

        <aside className="rail">
          <ContinueListening />
          <YotoRail playlists={playlists.data ?? []} loading={playlists.isLoading} />
        </aside>
      </div>
    </>
  );
}

function ContinueListening() {
  const p = usePlayer();
  if (!p.current) return null;
  return (
    <div className="panel">
      <div className="eyebrow" style={{ marginBottom: 10 }}>
        Continue listening
      </div>
      <div className="row" style={{ "--gap": "14px", alignItems: "flex-start" } as React.CSSProperties}>
        {p.current.cover && <img src={p.current.cover} alt="" style={{ width: 64, height: 64, borderRadius: 8, objectFit: "cover" }} />}
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

function YotoRail({ playlists, loading }: { playlists: Playlist[]; loading: boolean }) {
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
            <Link key={p.id} to={`/yoto/playlists/${p.id}`} className="row" style={{ "--gap": "12px", alignItems: "center" } as React.CSSProperties}>
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
