import { useQuery } from "@tanstack/react-query";
import { BookOpen, CheckCircle2, Folder, Layers, Library, LibraryBig, Link2, Mic, Search, SquareStack } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api";
import SendToYoto, { SendProgressModal, useConnectYoto } from "../components/SendToYoto";
import { Button, Empty, Meter, Modal, Note, PageHead, Spinner, errorText, useToast } from "../components/ui";
import { duration, mb, relative } from "../format";
import { useJobs } from "../hooks/queries";
import { useMe } from "../hooks/session";
import type { Book, Collection, Job, PackGroup, Playlist, Podcast, PodcastDetail, SettingsData, Track, YotoAccount } from "../types";
import { seasonGroups, seasonKey, seasonLabel } from "../seasons";
import { JobLine } from "./BookDetail";
import { usePresets } from "../components/Tools";

const CARD_BYTES = 500 * 1024 * 1024;

export function statusPill(status: Playlist["status"]) {
  const map = {
    draft: ["", "Not sent yet"],
    syncing: ["honey", "Sending…"],
    synced: ["sage", "On Yoto"],
    changed: ["honey", "Changed; send again"],
    failed: ["berry", "Didn't send"],
  } as const;
  const [tone, label] = map[status];
  return <span className={`pill ${tone}`}>{status === "synced" && <CheckCircle2 size={11} />} {label}</span>;
}

/**
 * "Bundle & send to Yoto": pick several books, shows or folders, then plan and send them as one set of cards.
 * Lives on the Library and the Yoto page; ``startOpen`` opens straight on the picker (the Yoto page's ?new=1).
 */
export function BundleButton({
  returnTo,
  variant = "primary",
  startOpen = false,
  label = "Bundle & send to Yoto",
}: {
  returnTo: string;
  variant?: "primary" | "sage" | "ghost";
  startOpen?: boolean;
  label?: string;
}) {
  const [picking, setPicking] = useState(startOpen);
  const [planGroups, setPlanGroups] = useState<PackGroup[] | null>(null);
  return (
    <>
      <Button variant={variant} icon={<Layers size={17} />} onClick={() => setPicking(true)} title="Pick several books or shows and put them on Yoto cards together">
        {label}
      </Button>
      {picking && (
        <SourcePicker
          onClose={() => setPicking(false)}
          onPicked={(groups) => {
            setPicking(false);
            setPlanGroups(groups);
          }}
        />
      )}
      {planGroups && <SendToYoto source={{ kind: "groups", groups: planGroups }} returnTo={returnTo} onClose={() => setPlanGroups(null)} />}
    </>
  );
}

/** How to make a card, in three steps, with the way in. */
function HowTo() {
  return (
    <section className="panel howto">
      <h3>How to make a Yoto card</h3>
      <ol className="howto-steps">
        <li>
          <span className="howto-n">1</span>
          <span>
            Go to your <b>Library</b> and pick a book
          </span>
        </li>
        <li>
          <span className="howto-n">2</span>
          <span>
            Tap <b>Send to Yoto</b>
          </span>
        </li>
        <li>
          <span className="howto-n">3</span>
          <span>
            In the <b>Yoto app</b>, open Library and link it to a blank card
          </span>
        </li>
      </ol>
      <div className="row wrap" style={{ gap: 10, marginTop: 14 }}>
        <Link className="btn primary" to="/library">
          <LibraryBig size={17} /> Go to Library
        </Link>
        <BundleButton returnTo="/yoto" variant="sage" label="Or bundle several together" />
      </div>
    </section>
  );
}

export default function Yoto() {
  const [params] = useSearchParams();
  const toast = useToast();
  const connect = useConnectYoto();
  const isAdmin = !!useMe()?.is_admin;
  const accounts = useQuery({ queryKey: ["yoto-accounts"], queryFn: () => api.get<YotoAccount[]>("/yoto/accounts") });
  const playlists = useQuery({ queryKey: ["playlists"], queryFn: () => api.get<Playlist[]>("/yoto/playlists") });
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api.get<SettingsData>("/settings") });
  const jobs = useJobs();
  // ?new=1 opens straight on "pick several to put on cards".
  const startBundle = params.get("new") === "1";
  const [following, setFollowing] = useState<{ id: number; title: string; batch?: string; playlistIds?: number[] } | null>(null);
  const [sendingKey, setSendingKey] = useState("");

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
  const sendJobs = (jobs.data ?? []).filter(
    (j) => (j.kind === "yoto_sync" || j.kind === "yoto_send") && (j.status === "running" || j.status === "queued"),
  );
  const hasYotoApp = !!settings.data?.capabilities.yoto_ready;
  const anyOnYoto = (playlists.data ?? []).some((p) => p.status === "synced");

  async function send(key: string, items: Playlist[], title: string) {
    setSendingKey(key);
    try {
      const single = key.startsWith("single-");
      const body = single ? { playlist_ids: items.map((p) => p.id) } : { batch: key };
      const job = await api.post<Job>("/yoto/sync", body);
      jobs.refetch();
      setFollowing({ id: job.id, title, ...(single ? { playlistIds: items.map((p) => p.id) } : { batch: key }) });
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setSendingKey("");
    }
  }

  return (
    <>
      <PageHead
        eyebrow="Yoto"
        title="Your Yoto cards"
        lede="Books, podcasts and folders you've sent to your Yoto app, packed onto as few 500 MB cards as possible."
        actions={<BundleButton returnTo="/yoto" startOpen={startBundle} />}
      />

      {!accounts.isLoading && !connected && (
        <div className="panel" style={{ marginBottom: 18, display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap" }}>
          <div className="card-art" style={{ width: 54 }}>
            <SquareStack size={20} />
          </div>
          <div style={{ flex: 1, minWidth: 240 }}>
            <h3 style={{ marginBottom: 4 }}>Connect your Yoto account</h3>
            <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
              {hasYotoApp
                ? "So cards go straight to your Yoto app. You'll sign in on Yoto's site and come right back here."
                : isAdmin
                  ? "First add the site's Yoto app in Settings (from dashboard.yoto.dev); then everyone can connect with one button."
                  : "Yoto isn't switched on for this site yet. Ask a super admin to set it up."}
            </p>
          </div>
          {hasYotoApp ? (
            <Button variant="primary" icon={<Link2 size={16} />} onClick={() => void connect("/yoto")}>
              Connect Yoto
            </Button>
          ) : (
            isAdmin && <Link className="btn" to="/settings#yoto">Open Settings</Link>
          )}
        </div>
      )}

      <HowTo />

      {sendJobs.map((j) => (
        <JobLine key={j.id} job={j} />
      ))}

      {anyOnYoto && (
        <div style={{ marginTop: 16 }}>
          <Note tone="ok">
            <b>Cards on Yoto are waiting in the Yoto app.</b> Open the Yoto app, tap Library, find the playlist, and link it to a blank card.
          </Note>
        </div>
      )}

      {playlists.isLoading ? (
        <Spinner />
      ) : (
        batches.length > 0 && (
          <div className="stack" style={{ "--gap": "26px", marginTop: 22 } as React.CSSProperties}>
            {batches.map(({ key, items }) => {
              const unsent = items.filter((p) => p.status !== "synced").length;
              const title = items.length > 1 ? items[0].title.replace(/ \(\d+ of \d+\)$/, "") : items[0].title;
              return (
                <section key={key} className={key === highlight ? "panel" : undefined}>
                  <div className="row wrap" style={{ marginBottom: 12 }}>
                    <h3 style={{ flex: 1 }}>
                      {title}
                      {items.length > 1 && <span className="muted"> · {items.length} cards</span>}
                    </h3>
                    {unsent > 0 ? (
                      <Button
                        variant="primary"
                        size="sm"
                        icon={<SquareStack size={15} />}
                        disabled={!connected}
                        loading={sendingKey === key}
                        onClick={() => void send(key, items, title)}
                      >
                        {items.some((p) => p.card_id) ? "Resend to Yoto" : "Send to Yoto"}
                      </Button>
                    ) : (
                      <span className="pill sage">
                        <CheckCircle2 size={11} /> On Yoto
                      </span>
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
                            {p.item_count} tracks · {duration(p.total_duration_ms)} · {Math.round((p.total_bytes / CARD_BYTES) * 100)}% full
                          </div>
                          <Meter value={p.total_bytes / CARD_BYTES} />
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
        )
      )}

      {following && <SendProgressModal jobId={following.id} title={following.title} batch={following.batch} playlistIds={following.playlistIds} onClose={() => setFollowing(null)} />}
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

/** Adding to a card that already exists: what it's called and how much room it has left. */
export type PickTarget = { title: string; freeBytes: number };

export function SourcePicker({ onClose, onPicked, addTo }: { onClose: () => void; onPicked: (groups: PackGroup[]) => void | Promise<void>; addTo?: PickTarget }) {
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
  // New cards can take any book: one not downloaded yet is downloaded during the send. Adding to a card that's
  // already made needs the audio here now.
  const presets = usePresets();
  const readyBooks = (books.data ?? []).filter((b) => b.track_count > 0 || (!addTo && b.runtime_min > 0));
  const notHere = (b: Book) => b.track_count === 0;
  // A book not downloaded yet: about the size it'll come down at.
  const bookBytes = (b: Book) => (notHere(b) ? (b.runtime_min * 60 * (presets.data?.default_kbps ?? 64) * 1000) / 8 : b.size_bytes);
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
            if (notHere(book)) return { key, title: book.title, series: book.series || undefined, track_ids: [], book_id: book.id, estimate_ms: book.runtime_min * 60000 };
            const tracks = await api.get<Track[]>(`/tracks?book_id=${id}`);
            return { key, title: book.title, series: book.series || undefined, track_ids: tracks.map((t) => t.id) };
          }
          if (kind === "podcast") return (await showGroups(id)).find((g) => g.key === key);
          const tracks = await api.get<Track[]>(`/tracks?collection_id=${id}`);
          return { key, title: folders.data!.find((c) => String(c.id) === id)!.name, track_ids: tracks.map((t) => t.id) };
        }),
      );
      await onPicked(groups.filter((g): g is PackGroup => !!g));
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
    [
      inSeries && b.series_position ? `Book ${b.series_position}` : "",
      b.authors,
      notHere(b) ? "Downloads when you send" : `${b.track_count} chapters`,
      duration(b.runtime_min * 60000),
      `${notHere(b) ? "about " : ""}${mb(bookBytes(b))}`,
    ]
      .filter(Boolean)
      .join(" · ");
  // Size and length of every ticked source, so you can see how they'll group against a card's limits.
  const sizeOf = new Map<string, number>([
    ...readyBooks.map((b) => [`book:${b.id}`, bookBytes(b)] as const),
    ...(podcasts.data ?? []).flatMap((p) => savedSeasons(p).map((s) => [s.key, s.downloaded_bytes] as const)),
    ...(folders.data ?? []).map((c) => [`folder:${c.id}`, c.current_bytes] as const),
  ]);
  const lengthOf = new Map<string, number>([
    ...readyBooks.map((b) => [`book:${b.id}`, b.runtime_min * 60000] as const),
    ...(podcasts.data ?? []).flatMap((p) => savedSeasons(p).map((s) => [s.key, s.downloaded_duration_ms] as const)),
    ...(folders.data ?? []).map((c) => [`folder:${c.id}`, c.total_duration_ms] as const),
  ]);
  const chosenBytes = [...chosen].reduce((a, k) => a + (sizeOf.get(k) ?? 0), 0);
  const chosenMs = [...chosen].reduce((a, k) => a + (lengthOf.get(k) ?? 0), 0);
  const tooBig = !!addTo && chosenBytes > addTo.freeBytes;
  const count = `${chosen.size} picked`;

  return (
    <Modal
      wide
      title={addTo ? `Add to “${addTo.title}”` : "Pick what to put on Yoto cards"}
      onClose={onClose}
      footer={
        <>
          <span className="picker-total tabular" role="status" aria-live="polite">
            {chosen.size ? (
              <>
                <strong className={tooBig ? "over" : undefined}>{mb(chosenBytes)}</strong> selected · {duration(chosenMs)}
                {addTo && <> · {mb(Math.max(0, addTo.freeBytes))} free on this card</>}
              </>
            ) : addTo ? (
              `${mb(Math.max(0, addTo.freeBytes))} free on this card`
            ) : (
              "Nothing selected yet"
            )}
          </span>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!chosen.size} loading={busy} onClick={build}>
            {addTo ? `Add (${count})` : chosen.size ? `Next (${count})` : "Next"}
          </Button>
        </>
      }
    >
      {loading ? (
        <Spinner />
      ) : nothingReady ? (
        <Empty title="Nothing downloaded yet">Go to your Library and tap Send to Yoto on a book; it's downloaded for you.</Empty>
      ) : (
        <div className="stack" style={{ "--gap": "18px" } as React.CSSProperties}>
          <p className="muted">
            {addTo
              ? "Only audio that's already converted or downloaded can go on a card. What you pick goes on the end of this card, in the order shown; you can rearrange it afterwards."
              : "Tick a whole series, or a few seasons of a show, and they'll play back to back on as few cards as possible. Books that aren't downloaded yet are downloaded when you send; podcast episodes need saving on the show's page first."}
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
                            Whole series · {bl.books.length} books · {duration(hours)} · {mb(bl.books.reduce((a, b) => a + bookBytes(b), 0))}
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
                    return row(s.key, <Mic size={16} />, p.title, `${which}${episodes(s.downloaded_count)} · ${duration(s.downloaded_duration_ms)} · ${mb(s.downloaded_bytes)}`);
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
                            Every season · {seasons.length} seasons · {episodes(p.downloaded_count)} · {mb(seasons.reduce((a, s) => a + s.downloaded_bytes, 0))}
                          </div>
                        </div>
                      </label>
                      {seasons.map((s) => row(s.key, <Mic size={16} />, s.label, `${episodes(s.downloaded_count)} · ${duration(s.downloaded_duration_ms)} · ${mb(s.downloaded_bytes)}`, true))}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {readyFolders.length > 0 && (
            <div className="stack">
              <strong>My own files</strong>
              <div className="list">
                {readyFolders.map((c) => row(`folder:${c.id}`, <Folder size={16} />, c.name, `${c.track_count} files · ${duration(c.total_duration_ms)} · ${mb(c.current_bytes)}`))}
              </div>
            </div>
          )}
          {!blocks.length && !readyPodcasts.length && !readyFolders.length && <p className="muted">Nothing matches “{term}”.</p>}
        </div>
      )}
    </Modal>
  );
}
