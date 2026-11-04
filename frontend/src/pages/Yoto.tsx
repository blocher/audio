import { useQuery } from "@tanstack/react-query";
import { BookOpen, CheckCircle2, CloudUpload, Folder, Link2, Mic, Plus, SquareStack } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api";
import CardPlanner from "../components/CardPlanner";
import { Button, Empty, Meter, Modal, Note, PageHead, Spinner, errorText, useToast } from "../components/ui";
import { bytes, duration, relative } from "../format";
import { useAction, useJobs } from "../hooks/queries";
import type { Book, Collection, Job, PackGroup, Playlist, Podcast, PodcastDetail, SettingsData, Track, YotoAccount } from "../types";
import { JobLine } from "./BookDetail";

const CARD_BYTES = 500 * 1024 * 1024;
const CARD_MS = 5 * 3600 * 1000;

export function statusPill(status: Playlist["status"]) {
  const map = {
    draft: ["", "Draft"],
    syncing: ["honey", "Syncing…"],
    synced: ["sage", "On Yoto"],
    changed: ["honey", "Changed since sync"],
    failed: ["berry", "Sync failed"],
  } as const;
  const [tone, label] = map[status];
  return <span className={`pill ${tone}`}>{status === "synced" && <CheckCircle2 size={11} />} {label}</span>;
}

export function useConnectYoto() {
  const toast = useToast();
  return async () => {
    try {
      const { authorize_url } = await api.post<{ authorize_url: string }>("/yoto/accounts", { name: "Family" });
      window.location.href = authorize_url;
    } catch (e) {
      toast(errorText(e), "error");
    }
  };
}

export default function Yoto() {
  const [params, setParams] = useSearchParams();
  const toast = useToast();
  const connect = useConnectYoto();
  const accounts = useQuery({ queryKey: ["yoto-accounts"], queryFn: () => api.get<YotoAccount[]>("/yoto/accounts") });
  const playlists = useQuery({ queryKey: ["playlists"], queryFn: () => api.get<Playlist[]>("/yoto/playlists") });
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api.get<SettingsData>("/settings") });
  const jobs = useJobs();
  const [picking, setPicking] = useState(false);
  const [connectError, setConnectError] = useState(params.get("error") ?? "");
  const [planGroups, setPlanGroups] = useState<PackGroup[] | null>(null);
  const sync = useAction((body: { batch?: string; playlist_ids?: number[] }) => api.post<Job>("/yoto/sync", body), [["playlists"]]);

  useEffect(() => {
    if (params.get("connected")) toast("Yoto account connected");
    if (params.get("error")) setConnectError(params.get("error")!);
    if (params.get("connected") || params.get("error")) {
      const next = new URLSearchParams(params);
      next.delete("connected");
      next.delete("error");
      setParams(next, { replace: true });
    }
  }, [params, setParams, toast]);

  const connected = (accounts.data ?? []).some((a) => a.connected);
  const highlight = params.get("batch");
  const batches = useMemo(() => {
    const groups = new Map<string, Playlist[]>();
    for (const p of playlists.data ?? []) {
      const key = p.batch || `single-${p.id}`;
      groups.set(key, [...(groups.get(key) ?? []), p]);
    }
    const list = [...groups.entries()].map(([key, items]) => ({ key, items: items.sort((a, b) => a.id - b.id) }));
    list.sort((a, b) => (a.key === highlight ? -1 : b.key === highlight ? 1 : 0));
    return list;
  }, [playlists.data, highlight]);
  const syncJobs = (jobs.data ?? []).filter((j) => j.kind === "yoto_sync" && (j.status === "running" || j.status === "queued"));
  const hasYotoApp = !!settings.data?.yoto.client_id;

  return (
    <>
      <PageHead
        eyebrow="Yoto"
        title="Ready for little ears"
        lede="Pack books, podcasts and folders onto as few cards as possible, then send them to your Yoto account."
        actions={
          <Button variant="primary" icon={<Plus size={18} />} onClick={() => setPicking(true)}>
            Plan new cards
          </Button>
        }
      />

      {connectError && !connected && (
        <div style={{ marginBottom: 16 }}>
          <Note tone="error">Yoto sign-in didn't finish: {connectError}</Note>
        </div>
      )}

      {!accounts.isLoading && !connected && (
        <div className="panel" style={{ marginBottom: 22, display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap" }}>
          <div className="card-art" style={{ width: 54 }}>
            <SquareStack size={20} />
          </div>
          <div style={{ flex: 1, minWidth: 240 }}>
            <h3 style={{ marginBottom: 4 }}>Connect your Yoto account</h3>
            <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
              {hasYotoApp ? "You'll sign in on Yoto's site and come straight back." : "First add your Yoto app's client ID and secret in Settings (from dashboard.yoto.dev)."}
            </p>
          </div>
          {hasYotoApp ? (
            <Button variant="sage" icon={<Link2 size={16} />} onClick={connect}>Connect Yoto</Button>
          ) : (
            <Link className="btn" to="/settings#yoto">Open Settings</Link>
          )}
        </div>
      )}

      {syncJobs.map((j) => (
        <JobLine key={j.id} job={j} />
      ))}

      {playlists.isLoading ? (
        <Spinner />
      ) : batches.length ? (
        <div className="stack" style={{ "--gap": "26px", marginTop: 18 } as React.CSSProperties}>
          {batches.map(({ key, items }) => {
            const unsynced = items.filter((p) => p.status !== "synced").length;
            return (
              <section key={key} className={key === highlight ? "panel" : undefined}>
                <div className="row" style={{ marginBottom: 12 }}>
                  <h3 style={{ flex: 1 }}>
                    {items.length > 1 ? `${items[0].title.replace(/ \(\d+ of \d+\)$/, "")} · ${items.length} cards` : items[0].title}
                  </h3>
                  {items.length > 1 && (
                    <Button
                      variant={unsynced ? "sage" : undefined}
                      size="sm"
                      icon={<CloudUpload size={15} />}
                      disabled={!connected}
                      loading={sync.isPending}
                      onClick={() =>
                        sync.mutate(key.startsWith("single-") ? { playlist_ids: items.map((p) => p.id) } : { batch: key }, {
                          onSuccess: () => toast(`Syncing ${items.length} cards to Yoto`),
                          onError: (e) => toast(errorText(e), "error"),
                        })
                      }
                    >
                      {unsynced ? `Sync ${items.length} cards` : "Re-sync all"}
                    </Button>
                  )}
                </div>
                <div className="plan-grid">
                  {items.map((p, n) => (
                    <Link key={p.id} to={`/yoto/playlists/${p.id}`} className="yoto-card">
                      <div className="card-art">
                        {p.cover_url ? <img src={p.cover_url} alt="" /> : <SquareStack size={22} />}
                        {items.length > 1 && <span className="n">{n + 1}</span>}
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div className="truncate" style={{ fontWeight: 650 }}>{p.title}</div>
                        <div className="muted tabular" style={{ fontSize: "var(--text-xs)", margin: "2px 0 8px" }}>
                          {p.item_count} tracks · {duration(p.total_duration_ms)} · {bytes(p.total_bytes)}
                        </div>
                        <Meter value={Math.max(p.total_bytes / CARD_BYTES, p.total_duration_ms / CARD_MS)} />
                        <div className="row" style={{ marginTop: 8, "--gap": "6px" } as React.CSSProperties}>
                          {statusPill(p.status)}
                          {p.last_synced_at && <span className="muted" style={{ fontSize: "var(--text-xs)" }}>{relative(p.last_synced_at)}</span>}
                        </div>
                      </div>
                    </Link>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <Empty icon={<SquareStack size={40} />} title="No cards yet" action={<Button variant="primary" onClick={() => setPicking(true)}>Plan your first cards</Button>}>
          Choose a book, a podcast or a folder and we'll work out the fewest cards it fits on.
        </Empty>
      )}

      {picking && (
        <SourcePicker
          onClose={() => setPicking(false)}
          onPicked={(groups) => {
            setPicking(false);
            setPlanGroups(groups);
          }}
        />
      )}
      {planGroups && <CardPlanner groups={planGroups} onClose={() => setPlanGroups(null)} />}
    </>
  );
}

function SourcePicker({ onClose, onPicked }: { onClose: () => void; onPicked: (groups: PackGroup[]) => void }) {
  const books = useQuery({ queryKey: ["books"], queryFn: () => api.get<Book[]>("/audible/books") });
  const podcasts = useQuery({ queryKey: ["podcasts"], queryFn: () => api.get<Podcast[]>("/podcasts") });
  const folders = useQuery({ queryKey: ["collections"], queryFn: () => api.get<Collection[]>("/local/collections") });
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const toggle = (key: string) =>
    setChosen((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const readyBooks = (books.data ?? []).filter((b) => b.track_count > 0);
  const readyPodcasts = (podcasts.data ?? []).filter((p) => p.downloaded_count > 0);
  const readyFolders = (folders.data ?? []).filter((c) => c.track_count > 0);

  async function build() {
    setBusy(true);
    setError("");
    try {
      const groups: PackGroup[] = [];
      for (const key of chosen) {
        const [kind, id] = key.split(":");
        if (kind === "book") {
          const tracks = await api.get<Track[]>(`/tracks?book_id=${id}`);
          groups.push({ key, title: readyBooks.find((b) => String(b.id) === id)!.title, track_ids: tracks.map((t) => t.id) });
        } else if (kind === "podcast") {
          const detail = await api.get<PodcastDetail>(`/podcasts/${id}`);
          const eps = detail.episodes.filter((e) => e.track).sort((a, b) => (a.published_at ?? "").localeCompare(b.published_at ?? ""));
          groups.push({ key, title: detail.title, track_ids: eps.map((e) => e.track!.id) });
        } else {
          const tracks = await api.get<Track[]>(`/tracks?collection_id=${id}`);
          groups.push({ key, title: readyFolders.find((c) => String(c.id) === id)!.name, track_ids: tracks.map((t) => t.id) });
        }
      }
      onPicked(groups);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const loading = books.isLoading || podcasts.isLoading || folders.isLoading;
  const Row = ({ k, icon, title, sub }: { k: string; icon: React.ReactNode; title: string; sub: string }) => (
    <label className="list-row" style={{ gridTemplateColumns: "auto auto 1fr", cursor: "pointer" }}>
      <input type="checkbox" checked={chosen.has(k)} onChange={() => toggle(k)} style={{ accentColor: "var(--terracotta)", width: 16, height: 16 }} />
      {icon}
      <div style={{ minWidth: 0 }}>
        <div className="title truncate">{title}</div>
        <div className="sub">{sub}</div>
      </div>
    </label>
  );

  return (
    <Modal
      wide
      title="What should go on the cards?"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!chosen.size} loading={busy} onClick={build}>
            Plan {chosen.size || ""} source{chosen.size === 1 ? "" : "s"}
          </Button>
        </>
      }
    >
      {loading ? (
        <Spinner />
      ) : (
        <div className="stack" style={{ "--gap": "18px" } as React.CSSProperties}>
          <p className="muted">Only audio that's already converted or downloaded can go on a card. Pick several to share cards between them.</p>
          {error && <Note tone="error">{error}</Note>}
          {readyBooks.length > 0 && (
            <div className="stack">
              <strong>Audiobooks</strong>
              <div className="list">
                {readyBooks.map((b) => (
                  <Row key={b.id} k={`book:${b.id}`} icon={<BookOpen size={16} />} title={b.title} sub={`${b.authors} · ${b.track_count} chapters · ${duration(b.runtime_min * 60000)}`} />
                ))}
              </div>
            </div>
          )}
          {readyPodcasts.length > 0 && (
            <div className="stack">
              <strong>Podcasts</strong>
              <div className="list">
                {readyPodcasts.map((p) => (
                  <Row key={p.id} k={`podcast:${p.id}`} icon={<Mic size={16} />} title={p.title} sub={`${p.downloaded_count} saved episodes · ${bytes(p.downloaded_bytes)}`} />
                ))}
              </div>
            </div>
          )}
          {readyFolders.length > 0 && (
            <div className="stack">
              <strong>Local folders</strong>
              <div className="list">
                {readyFolders.map((c) => (
                  <Row key={c.id} k={`folder:${c.id}`} icon={<Folder size={16} />} title={c.name} sub={`${c.track_count} files · ${duration(c.total_duration_ms)}`} />
                ))}
              </div>
            </div>
          )}
          {!readyBooks.length && !readyPodcasts.length && !readyFolders.length && (
            <Empty title="Nothing ready yet">Convert a book, download some episodes, or import a folder first.</Empty>
          )}
        </div>
      )}
    </Modal>
  );
}
