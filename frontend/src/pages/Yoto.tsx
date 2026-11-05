import { useQuery } from "@tanstack/react-query";
import { BookOpen, CheckCircle2, CloudUpload, Folder, Library, Link2, Mic, Plus, Search, SquareStack } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api";
import CardPlanner from "../components/CardPlanner";
import { Button, Empty, Meter, Modal, Note, PageHead, Spinner, errorText, useToast } from "../components/ui";
import { bytes, duration, relative } from "../format";
import { useAction, useJobs } from "../hooks/queries";
import type { Book, Collection, Job, PackGroup, Playlist, Podcast, PodcastDetail, SettingsData, Track, YotoAccount } from "../types";
import { seasonGroups, seasonKey, seasonLabel } from "../seasons";
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

const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
const seriesNumber = (b: Book) => parseFloat(b.series_position.match(/\d+(\.\d+)?/)?.[0] ?? "") || Infinity;

type BookBlock = { name: string; series: string; books: Book[] };

/** Every series a book is in. Books synced before series_list existed only know their first one. */
const allSeries = (b: Book) => (b.series_list?.length ? b.series_list : b.series ? [{ title: b.series, position: b.series_position }] : []);

/**
 * Books grouped into series (two or more ready books) and standalones, all in reading order.
 * Audible can list several series for a book, in any order, so each book joins the one it shares
 * with the most other books here; a tie goes to the series more books list first, so every book
 * settles the same way. Books in a block carry that series' name and position.
 */
function bookBlocks(books: Book[]): BookBlock[] {
  const count = new Map<string, number>();
  const first = new Map<string, number>();
  for (const b of books) {
    const list = allSeries(b);
    for (const t of new Set(list.map((s) => s.title))) count.set(t, (count.get(t) ?? 0) + 1);
    if (list[0]) first.set(list[0].title, (first.get(list[0].title) ?? 0) + 1);
  }
  const score = (t: string) => (count.get(t) ?? 0) * books.length + (first.get(t) ?? 0);
  const bySeries = new Map<string, Book[]>();
  const blocks: BookBlock[] = [];
  for (const b of books) {
    let best: { title: string; position: string } | undefined;
    for (const s of allSeries(b)) if ((count.get(s.title) ?? 0) > 1 && (!best || score(s.title) > score(best.title))) best = s;
    if (best) bySeries.set(best.title, [...(bySeries.get(best.title) ?? []), { ...b, series: best.title, series_position: best.position }]);
    else blocks.push({ name: b.title, series: "", books: [b] });
  }
  for (const [series, list] of bySeries) {
    if (list.length > 1) blocks.push({ name: series, series, books: list.sort((a, b) => seriesNumber(a) - seriesNumber(b) || natural(a.title, b.title)) });
    else blocks.push({ name: list[0].title, series: "", books: list });
  }
  return blocks.sort((a, b) => natural(a.name, b.name));
}

function SourcePicker({ onClose, onPicked }: { onClose: () => void; onPicked: (groups: PackGroup[]) => void }) {
  const books = useQuery({ queryKey: ["books"], queryFn: () => api.get<Book[]>("/audible/books") });
  const podcasts = useQuery({ queryKey: ["podcasts"], queryFn: () => api.get<Podcast[]>("/podcasts") });
  const folders = useQuery({ queryKey: ["collections"], queryFn: () => api.get<Collection[]>("/local/collections") });
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [term, setTerm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const setMany = (keys: string[], on: boolean) =>
    setChosen((s) => {
      const next = new Set(s);
      for (const k of keys) {
        if (on) next.add(k);
        else next.delete(k);
      }
      return next;
    });

  const q = term.trim().toLowerCase();
  const matches = (...fields: string[]) => !q || fields.some((f) => f.toLowerCase().includes(q));
  const readyBooks = (books.data ?? []).filter((b) => b.track_count > 0);
  const blocks = bookBlocks(readyBooks.filter((b) => matches(b.title, b.authors, ...allSeries(b).map((s) => s.title))));
  const readyPodcasts = (podcasts.data ?? []).filter((p) => p.downloaded_count > 0 && matches(p.title, p.author)).sort((a, b) => natural(a.title, b.title));
  const readyFolders = (folders.data ?? []).filter((c) => c.track_count > 0 && matches(c.name)).sort((a, b) => natural(a.name, b.name));
  // A show's seasons with saved episodes, keyed the way seasonGroups keys them.
  const savedSeasons = (p: Podcast) =>
    p.seasons.filter((s) => s.downloaded_count > 0).map((s) => ({ ...s, key: seasonKey(p.id, s.season, p.seasons.length > 1), label: seasonLabel(s.season, p.seasons.length > 1) }));
  const nothingReady = !readyBooks.length && !(podcasts.data ?? []).some((p) => p.downloaded_count > 0) && !(folders.data ?? []).some((c) => c.track_count > 0);

  async function build() {
    setBusy(true);
    setError("");
    try {
      // Sources go to the planner in the order shown here (series in reading order); it can reorder them.
      const all = bookBlocks(readyBooks);
      const grouped = new Map(all.flatMap((bl) => bl.books.map((b) => [String(b.id), b] as const)));
      const keys = [
        ...all.flatMap((bl) => bl.books.map((b) => `book:${b.id}`)),
        ...(podcasts.data ?? [])
          .filter((p) => p.downloaded_count > 0)
          .sort((a, b) => natural(a.title, b.title))
          .flatMap((p) => savedSeasons(p).map((s) => s.key)),
        ...(folders.data ?? []).filter((c) => c.track_count > 0).sort((a, b) => natural(a.name, b.name)).map((c) => `folder:${c.id}`),
      ].filter((k) => chosen.has(k));
      // One fetch per show, however many of its seasons were picked.
      const shows = new Map<string, Promise<PackGroup[]>>();
      const showGroups = (id: string) => {
        if (!shows.has(id)) shows.set(id, api.get<PodcastDetail>(`/podcasts/${id}`).then((d) => seasonGroups(d, d.episodes)));
        return shows.get(id)!;
      };
      const groups = await Promise.all(
        keys.map(async (key): Promise<PackGroup | undefined> => {
          const [kind, id] = key.split(":");
          if (kind === "book") {
            const book = grouped.get(id)!;
            const tracks = await api.get<Track[]>(`/tracks?book_id=${id}`);
            return { key, title: book.title, series: book.series || undefined, track_ids: tracks.map((t) => t.id) };
          }
          if (kind === "podcast") return (await showGroups(id)).find((g) => g.key === key);
          const tracks = await api.get<Track[]>(`/tracks?collection_id=${id}`);
          return { key, title: folders.data!.find((c) => String(c.id) === id)!.name, track_ids: tracks.map((t) => t.id) };
        }),
      );
      onPicked(groups.filter((g): g is PackGroup => !!g));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const loading = books.isLoading || podcasts.isLoading || folders.isLoading;
  const box = { accentColor: "var(--terracotta)", width: 16, height: 16 };
  const row = (k: string, icon: React.ReactNode, title: string, sub: string, indent = false) => (
    <label key={k} className="list-row" style={{ gridTemplateColumns: "auto auto 1fr", cursor: "pointer", paddingLeft: indent ? 40 : undefined }}>
      <input type="checkbox" checked={chosen.has(k)} onChange={(e) => setMany([k], e.target.checked)} style={box} />
      {icon}
      <div style={{ minWidth: 0 }}>
        <div className="title truncate">{title}</div>
        <div className="sub">{sub}</div>
      </div>
    </label>
  );
  const bookSub = (b: Book, inSeries: boolean) =>
    [inSeries && b.series_position ? `Book ${b.series_position}` : "", b.authors, `${b.track_count} chapters`, duration(b.runtime_min * 60000)].filter(Boolean).join(" · ");

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
      ) : nothingReady ? (
        <Empty title="Nothing ready yet">Convert a book, download some episodes, or import a folder first.</Empty>
      ) : (
        <div className="stack" style={{ "--gap": "18px" } as React.CSSProperties}>
          <p className="muted">
            Only audio that's already converted or downloaded can go on a card. Pick several (a whole series, or a few seasons of a show) and they'll play back to back
            on as few cards as possible.
          </p>
          <div className="search">
            <Search size={17} />
            <input className="input" placeholder="Filter by title, author or series" value={term} onChange={(e) => setTerm(e.target.value)} autoFocus />
          </div>
          {error && <Note tone="error">{error}</Note>}
          {blocks.length > 0 && (
            <div className="stack">
              <strong>Audiobooks</strong>
              <div className="list">
                {blocks.map((bl) => {
                  if (!bl.series) {
                    const b = bl.books[0];
                    return row(`book:${b.id}`, <BookOpen size={16} />, b.title, bookSub(b, false));
                  }
                  const keys = bl.books.map((b) => `book:${b.id}`);
                  const picked = keys.filter((k) => chosen.has(k)).length;
                  const hours = bl.books.reduce((a, b) => a + b.runtime_min, 0) * 60000;
                  return (
                    <div key={`series:${bl.series}`}>
                      <label className="list-row" style={{ gridTemplateColumns: "auto auto 1fr", cursor: "pointer" }}>
                        <input
                          type="checkbox"
                          checked={picked === keys.length}
                          ref={(el) => {
                            if (el) el.indeterminate = picked > 0 && picked < keys.length;
                          }}
                          onChange={(e) => setMany(keys, e.target.checked)}
                          style={box}
                          aria-label={`Whole ${bl.series} series`}
                        />
                        <Library size={16} />
                        <div style={{ minWidth: 0 }}>
                          <div className="title truncate">{bl.series}</div>
                          <div className="sub">
                            Whole series · {bl.books.length} books · {duration(hours)}
                          </div>
                        </div>
                      </label>
                      {bl.books.map((b) => row(`book:${b.id}`, <BookOpen size={16} />, b.title, bookSub(b, true), true))}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {readyPodcasts.length > 0 && (
            <div className="stack">
              <strong>Podcasts</strong>
              <div className="list">
                {readyPodcasts.map((p) => {
                  const seasons = savedSeasons(p);
                  const episodes = (n: number) => `${n} saved episode${n === 1 ? "" : "s"}`;
                  if (seasons.length === 1) {
                    const s = seasons[0];
                    const which = p.seasons.length > 1 ? `${s.label} · ` : "";
                    return row(s.key, <Mic size={16} />, p.title, `${which}${episodes(s.downloaded_count)} · ${bytes(p.downloaded_bytes)}`);
                  }
                  // Several seasons: like a book series, tick the whole show or just the seasons you want.
                  const keys = seasons.map((s) => s.key);
                  const picked = keys.filter((k) => chosen.has(k)).length;
                  return (
                    <div key={`show:${p.id}`}>
                      <label className="list-row" style={{ gridTemplateColumns: "auto auto 1fr", cursor: "pointer" }}>
                        <input
                          type="checkbox"
                          checked={picked === keys.length}
                          ref={(el) => {
                            if (el) el.indeterminate = picked > 0 && picked < keys.length;
                          }}
                          onChange={(e) => setMany(keys, e.target.checked)}
                          style={box}
                          aria-label={`Every season of ${p.title}`}
                        />
                        <Mic size={16} />
                        <div style={{ minWidth: 0 }}>
                          <div className="title truncate">{p.title}</div>
                          <div className="sub">
                            Every season · {seasons.length} seasons · {episodes(p.downloaded_count)} · {bytes(p.downloaded_bytes)}
                          </div>
                        </div>
                      </label>
                      {seasons.map((s) => row(s.key, <Mic size={16} />, s.label, `${episodes(s.downloaded_count)} · ${duration(s.downloaded_duration_ms)}`, true))}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {readyFolders.length > 0 && (
            <div className="stack">
              <strong>Local folders</strong>
              <div className="list">
                {readyFolders.map((c) => row(`folder:${c.id}`, <Folder size={16} />, c.name, `${c.track_count} files · ${duration(c.total_duration_ms)}`))}
              </div>
            </div>
          )}
          {!blocks.length && !readyPodcasts.length && !readyFolders.length && <p className="muted">Nothing matches “{term}”.</p>}
        </div>
      )}
    </Modal>
  );
}
