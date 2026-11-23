import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, CheckCircle2, GripVertical, Link2, PartyPopper, SquareStack, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { goToSignIn, here } from "../connect";
import { mb } from "../format";
import { useDragSort } from "../hooks/dragSort";
import { useActiveJob, useJobs } from "../hooks/queries";
import { useOnboarding } from "../hooks/session";
import { seasonGroups } from "../seasons";
import type { Book, Job, PackGroup, PackOptions, PackPreview, PackStrategy, PodcastDetail, Track, YotoAccount } from "../types";
import { usePresets } from "./Tools";
import { Button, Meter, Modal, Note, Progress, Spinner, errorText, useToast } from "./ui";

// ---------- wording shared with Settings ----------

export const PACK_STRATEGIES: { id: PackStrategy; label: string; hint: string }[] = [
  { id: "continuous", label: "Back to back", hint: "Everything plays in order. When one ends partway through a card, the next starts on the same card." },
  { id: "sequential", label: "Each on its own card", hint: "Everything plays in order, and each book or show starts on a fresh card." },
  { id: "compact", label: "Keep short ones whole", hint: "Short books and shows each stay whole on one card and may share it, so the cards aren't strictly in order." },
];

/** "Name (3 of 24)" when the set has a name; otherwise the packer's own title. */
export function cardTitle(name: string, n: number, total: number, fallback: string) {
  const trimmed = name.trim();
  if (!trimmed) return fallback;
  return total === 1 ? trimmed : `${trimmed} (${n} of ${total})`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A sensible name for several picks: their shared series, else the words their titles start with. */
function suggestName(groups: PackGroup[]): string {
  if (groups.length < 2) return "";
  const series = groups[0].series;
  if (series && groups.every((g) => g.series === series)) return series;
  const words = groups.map((g) => g.title.split(/\s+/));
  const shared: string[] = [];
  for (let i = 0; i < words[0].length; i++) {
    if (words.every((w) => w[i]?.toLowerCase() === words[0][i].toLowerCase())) shared.push(words[0][i]);
    else break;
  }
  const prefix = shared
    .join(" ")
    .replace(/[\s:,–—-]+(and|the|of|a|an|book|vol\.?|volume|part)?$/i, "")
    .trim();
  return prefix.length >= 4 ? prefix : "";
}

// ---------- connecting ----------

/** Whether this person can send to Yoto yet, and whether the site has Yoto switched on at all. */
export function useYoto() {
  const accounts = useQuery({ queryKey: ["yoto-accounts"], queryFn: () => api.get<YotoAccount[]>("/yoto/accounts") });
  const onboarding = useOnboarding();
  return {
    loading: accounts.isLoading,
    connected: (accounts.data ?? []).some((a) => a.connected),
    ready: onboarding.data?.yoto.ready ?? true,
  };
}

/** Sign in to Yoto in this tab; Yoto sends the browser straight back to `returnTo` (default: this page). */
export function useConnectYoto() {
  const toast = useToast();
  return async (returnTo?: string) => {
    try {
      const { authorize_url } = await api.post<{ authorize_url: string }>("/yoto/accounts", {
        name: "Family",
        popup: false,
        return_to: returnTo ?? here(),
      });
      await goToSignIn(authorize_url);
    } catch (e) {
      toast(errorText(e), "error");
    }
  };
}

// ---------- what to do once it's there ----------

/** The step people miss: the playlist is in the Yoto app's Library, waiting to be linked to a blank card. */
export function YotoNextSteps({ title, compact, celebrate }: { title?: string; compact?: boolean; celebrate?: boolean }) {
  const steps = (
    <ol className="next-steps">
      <li>Open the <b>Yoto app</b> on your phone.</li>
      <li>
        Tap <b>Library</b> and find {title ? <b>“{title}”</b> : "this playlist"}.
      </li>
      <li>
        Tap it, then <b>Link to card</b>, and hold a blank Make Your Own card to your player.
      </li>
    </ol>
  );
  if (compact) return steps;
  return (
    <div className="yoto-done">
      {celebrate && <Confetti />}
      <span className="yoto-done-icon">
        <PartyPopper size={28} />
      </span>
      <h3>You're all set!</h3>
      <p>Go to your Yoto app and select Library to find this playlist and create a custom card.</p>
      {steps}
    </div>
  );
}

/** A handful of paper bits that fall once. Purely decoration; hidden from screen readers and reduced motion. */
function Confetti() {
  const bits = useMemo(
    () =>
      Array.from({ length: 14 }, (_, i) => ({
        left: 6 + ((i * 37) % 88),
        delay: (i % 5) * 70,
        drift: ((i * 53) % 40) - 20,
        spin: ((i * 71) % 300) + 120,
        tone: i % 4,
      })),
    [],
  );
  return (
    <div className="confetti" aria-hidden>
      {bits.map((b, i) => (
        <i
          key={i}
          className={`c${b.tone}`}
          style={{ left: `${b.left}%`, animationDelay: `${b.delay}ms`, "--drift": `${b.drift}px`, "--spin": `${b.spin}deg` } as React.CSSProperties}
        />
      ))}
    </div>
  );
}

// ---------- following the upload ----------

/** Follows a send (or resend) job: progress while it runs, then "you're all set" or what went wrong. */
function SendProgress({ jobId, title, onRetry }: { jobId: number; title: string; onRetry?: () => void }) {
  const jobs = useJobs();
  const job = jobs.data?.find((j) => j.id === jobId);
  if (!job || job.status === "queued" || job.status === "running")
    return (
      <div className="stack send-progress" style={{ "--gap": "14px" } as React.CSSProperties}>
        <div className="row" style={{ "--gap": "10px" } as React.CSSProperties}>
          <Spinner size={20} />
          <strong style={{ fontSize: "var(--text-lg)" }}>Sending “{title}” to Yoto…</strong>
        </div>
        <Progress value={job?.progress ?? 0} tone="terracotta" thick />
        <div className="muted" style={{ fontSize: "var(--text-sm)" }}>
          {job?.message || "Starting"}
        </div>
        <Note tone="info">This takes a few minutes. You can close this window; it keeps going, and shows “On Yoto” when it's done.</Note>
      </div>
    );
  if (job.status === "succeeded") return <YotoNextSteps title={title} celebrate />;
  return (
    <div className="stack" style={{ "--gap": "12px" } as React.CSSProperties}>
      <Note tone="error">
        <b>That didn't finish.</b> {job.message || "Something went wrong."}
      </Note>
      {onRetry && (
        <Button variant="primary" onClick={onRetry} style={{ alignSelf: "flex-start" }}>
          Try again
        </Button>
      )}
    </div>
  );
}

/** A modal that only follows a job (e.g. "Send to Yoto" on cards already made). */
export function SendProgressModal({ jobId, title, onClose }: { jobId: number; title: string; onClose: () => void }) {
  const jobs = useJobs();
  const done = jobs.data?.find((j) => j.id === jobId)?.status === "succeeded";
  return (
    <Modal
      title="Send to Yoto"
      onClose={onClose}
      footer={
        <Button variant={done ? "primary" : "ghost"} onClick={onClose}>
          {done ? "Done" : "Close"}
        </Button>
      }
    >
      <SendProgress jobId={jobId} title={title} />
    </Modal>
  );
}

// ---------- the dialog ----------

export type SendSource =
  | { kind: "book"; book: Book }
  | { kind: "podcast"; id: number; title: string; cover: string }
  | { kind: "folder"; id: number; title: string }
  | { kind: "groups"; groups: PackGroup[]; cover?: string };

function sourceTitle(source: SendSource, groups: PackGroup[]) {
  if (source.kind === "book") return source.book.title;
  if (source.kind === "podcast" || source.kind === "folder") return source.title;
  return groups.length === 1 ? groups[0].title : `${groups.length} picks`;
}

/** The tracks behind a source, fetched when the dialog opens. A book not downloaded yet has none: it's estimated. */
function useSourceGroups(source: SendSource) {
  return useQuery({
    queryKey: ["send-groups", source.kind, source.kind === "book" ? source.book.id : source.kind === "groups" ? source.groups.map((g) => g.key).join() : source.id],
    queryFn: async (): Promise<PackGroup[]> => {
      if (source.kind === "groups") return source.groups;
      if (source.kind === "book") {
        if (!source.book.track_count) return [];
        const tracks = await api.get<Track[]>(`/tracks?book_id=${source.book.id}`);
        return [{ key: `book:${source.book.id}`, title: source.book.title, series: source.book.series || undefined, track_ids: tracks.filter((t) => t.has_file).map((t) => t.id) }];
      }
      if (source.kind === "podcast") {
        const d = await api.get<PodcastDetail>(`/podcasts/${source.id}`);
        return seasonGroups(d, d.episodes);
      }
      const tracks = await api.get<Track[]>(`/tracks?collection_id=${source.id}`);
      return [{ key: `folder:${source.id}`, title: source.title, track_ids: tracks.filter((t) => t.has_file).map((t) => t.id) }];
    },
    staleTime: 0,
  });
}

/**
 * Send something to Yoto: see how many cards it takes at each audio size, pick one, and press Send. One background
 * job does the rest (downloading a book first if it needs it), and this window follows it to "You're all set".
 */
export default function SendToYoto({ source, onClose, returnTo }: { source: SendSource; onClose: () => void; returnTo?: string }) {
  const book = source.kind === "book" ? source.book : null;
  const existing = book?.yoto_playlist_ids ?? [];
  const [mode, setMode] = useState<"plan" | "existing">(existing.length ? "existing" : "plan");
  const [jobId, setJobId] = useState<number | null>(null);
  // How to try again after a failure: the same request (a send carries its batch, so it reuses the same cards).
  const [again, setAgain] = useState<(() => Promise<Job>) | null>(null);
  const [batch] = useState(() => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, "0")).join(""));
  const toast = useToast();
  const qc = useQueryClient();
  const sent = (id: number, retry: () => Promise<Job>) => {
    setJobId(id);
    setAgain(() => retry);
  };
  const retry = async () => {
    if (!again) return setJobId(null);
    try {
      const job = await again();
      qc.invalidateQueries({ queryKey: ["jobs"] });
      setJobId(job.id);
    } catch (e) {
      toast(errorText(e), "error");
    }
  };
  const groupsQuery = useSourceGroups(source);
  const groups = groupsQuery.data;
  const title = sourceTitle(source, groups ?? []);
  const jobs = useJobs();
  const job = jobId ? jobs.data?.find((j) => j.id === jobId) : undefined;
  const done = job?.status === "succeeded";

  return (
    <Modal
      wide={mode === "plan" && !jobId}
      title={done ? "On Yoto" : "Send to Yoto"}
      onClose={onClose}
      footer={
        jobId ? (
          <>
            {done && (
              <Link to="/yoto" className="btn ghost" onClick={onClose}>
                See my Yoto cards
              </Link>
            )}
            <Button variant={done ? "primary" : "ghost"} onClick={onClose}>
              {done ? "Done" : "Close"}
            </Button>
          </>
        ) : undefined
      }
    >
      {jobId ? (
        <SendProgress jobId={jobId} title={title} onRetry={() => void retry()} />
      ) : mode === "existing" && book ? (
        <AlreadyMade book={book} onSent={sent} onNew={() => setMode("plan")} onClose={onClose} />
      ) : groupsQuery.isLoading ? (
        <Spinner />
      ) : groupsQuery.isError ? (
        <Note tone="error">{errorText(groupsQuery.error)}</Note>
      ) : !groups!.length && !(book && !book.track_count) ? (
        <Note tone="info">
          There's nothing to put on a card yet.{" "}
          {source.kind === "podcast" ? (
            <>
              Open the show and download some episodes first: <Link to={`/podcasts/${source.id}`} onClick={onClose}>open {source.title}</Link>.
            </>
          ) : (
            "Add some audio first."
          )}
        </Note>
      ) : (
        <Plan source={source} groups={groups!} title={title} batch={batch} onSent={sent} onClose={onClose} returnTo={returnTo} />
      )}
    </Modal>
  );
}

/** A book already on (or headed for) Yoto: send those cards again, or make new ones. */
function AlreadyMade({ book, onSent, onNew, onClose }: { book: Book; onSent: (id: number, retry: () => Promise<Job>) => void; onNew: () => void; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { connected } = useYoto();
  const connect = useConnectYoto();
  const [busy, setBusy] = useState(false);
  const count = book.yoto_playlist_ids.length;
  const onYoto = book.yoto_status === "synced";
  async function resend() {
    setBusy(true);
    try {
      const request = () => api.post<Job>("/yoto/sync", { playlist_ids: book.yoto_playlist_ids });
      const job = await request();
      qc.invalidateQueries({ queryKey: ["jobs"] });
      onSent(job.id, request);
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="stack" style={{ "--gap": "16px" } as React.CSSProperties}>
      {onYoto ? (
        <Note tone="ok">
          <b>“{book.title}” is already on Yoto</b> as {plural(count, "card")}.
        </Note>
      ) : (
        <p>
          You've made {plural(count, "card")} for “{book.title}”, but {count === 1 ? "it isn't" : "they aren't"} on Yoto yet.
        </p>
      )}
      {onYoto && <YotoNextSteps title={book.title} compact />}
      <div className="row wrap" style={{ gap: 10 }}>
        {connected ? (
          <Button variant="primary" icon={<SquareStack size={17} />} loading={busy} onClick={() => void resend()}>
            {onYoto ? "Resend to Yoto" : `Send ${count === 1 ? "it" : "them"} to Yoto`}
          </Button>
        ) : (
          <Button variant="primary" icon={<Link2 size={16} />} onClick={() => void connect(`/books/${book.id}?send=1`)}>
            Connect Yoto first
          </Button>
        )}
        <Link className="btn" to={count === 1 ? `/yoto/playlists/${book.yoto_playlist_ids[0]}` : "/yoto"} onClick={onClose}>
          See the {count === 1 ? "card" : "cards"}
        </Link>
        <Button variant="ghost" onClick={onNew}>
          Make new cards instead
        </Button>
      </div>
    </div>
  );
}

function Plan({
  source,
  groups,
  title,
  batch,
  onSent,
  onClose,
  returnTo,
}: {
  source: SendSource;
  groups: PackGroup[];
  title: string;
  batch: string;
  onSent: (id: number, retry: () => Promise<Job>) => void;
  onClose: () => void;
  returnTo?: string;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const presets = usePresets();
  const yoto = useYoto();
  const connect = useConnectYoto();
  const book = source.kind === "book" ? source.book : null;
  // A book that isn't downloaded yet: plan from its length; it's downloaded straight at the chosen size.
  const estimate = book && !book.track_count ? book.runtime_min * 60000 : 0;
  const [order, setOrder] = useState(groups);
  const several = order.length > 1;
  const [name, setName] = useState(() => suggestName(groups));
  const [strategy, setStrategy] = useState<PackStrategy>(several ? "continuous" : "sequential");
  const [kbps, setKbps] = useState<number | null | undefined>(undefined); // undefined: not chosen yet
  const [busy, setBusy] = useState(false);
  const mono = presets.data?.default_mono ?? true;

  const body = { groups: order, strategy, use_optimized: true, estimate_ms: estimate };
  const options = useQuery({
    queryKey: ["pack-options", JSON.stringify(body)],
    queryFn: () => api.post<PackOptions>("/pack/options", body),
    placeholderData: (prev) => prev,
  });
  const opts = useMemo(() => options.data?.options ?? [], [options.data]);

  // Recommend the best-sounding size among those that need the fewest cards ("as is" sounds best of all).
  const recommended = useMemo(() => {
    const fits = opts.filter((o) => o.cards !== null);
    if (!fits.length) return undefined;
    const fewest = Math.min(...fits.map((o) => o.cards!));
    const quality = (k: number | null) => k ?? Infinity;
    return fits.filter((o) => o.cards === fewest).reduce((best, o) => (quality(o.kbps) > quality(best.kbps) ? o : best)).kbps;
  }, [opts]);

  // Start on the recommended size.
  useEffect(() => {
    if (kbps !== undefined || !opts.length) return;
    setKbps(recommended === undefined ? opts[0].kbps : recommended);
  }, [opts, kbps, recommended]);

  const chosen = kbps === undefined ? undefined : opts.find((o) => o.kbps === kbps);
  const preview = useQuery({
    queryKey: ["pack", JSON.stringify({ ...body, kbps })],
    queryFn: () => api.post<PackPreview>("/pack/preview", { groups: order, strategy, kbps, use_optimized: true, max_hours: 0 }),
    enabled: !estimate && kbps !== undefined,
    placeholderData: (prev) => prev,
  });
  // The cards to draw: the real plan, or for a book not downloaded yet, full cards and a last one part full.
  const tiles = useMemo(() => {
    if (!estimate) return (preview.data?.cards ?? []).map((c, n, all) => ({ title: cardTitle(several ? name : "", n + 1, all.length, c.title), fill: c.fill }));
    const n = chosen?.cards ?? 0;
    return Array.from({ length: n }, (_, i) => ({ title: n > 1 ? `${title} (${i + 1} of ${n})` : title, fill: i === n - 1 ? chosen!.last_fill : 0.97 }));
  }, [estimate, preview.data, chosen, several, name, title]);
  const cards = chosen?.cards ?? 0;

  async function send() {
    setBusy(true);
    try {
      const body = {
        ...(book ? { book_id: book.id } : { groups: order }),
        strategy,
        kbps,
        mono,
        name: several ? name : "",
        cover_url: source.kind === "groups" ? (source.cover ?? "") : source.kind === "podcast" ? source.cover : "",
        batch,
      };
      const request = () => api.post<Job>("/yoto/send", body);
      const job = await request();
      qc.invalidateQueries({ queryKey: ["jobs"] });
      qc.invalidateQueries({ queryKey: ["books"] });
      onSent(job.id, request);
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  }

  const label = (k: number | null) => (k === null ? "As is" : (presets.data?.presets.find((p) => p.kbps === k)?.label ?? `${k} kbps`));

  return (
    <div className="stack" style={{ "--gap": "20px" } as React.CSSProperties}>
      <div className="send-top">
        <div className="send-summary">
          <span className="serif send-count">
            {options.isLoading || kbps === undefined ? <Spinner /> : cards ? `Fits on ${plural(cards, "card")}` : "Too big for a card"}
          </span>
          <span className="muted">
            {title}
            {estimate ? " · we'll download it from Audible first" : ""}
          </span>
        </div>
        {tiles.length > 0 && (
          <div className="ycards" aria-label="The cards">
            {tiles.slice(0, 8).map((t, i) => (
              <div key={i} className="ycard" title={`${t.title}: ${Math.round(Math.min(1, t.fill) * 100)}% full`}>
                <div className="ycard-face">
                  <span className="ycard-fill" style={{ height: `${Math.min(1, t.fill) * 100}%` }} />
                </div>
                <small className="tabular">{Math.round(Math.min(1, t.fill) * 100)}%</small>
              </div>
            ))}
            {tiles.length > 8 && <div className="muted" style={{ alignSelf: "center" }}>+{tiles.length - 8}</div>}
          </div>
        )}
      </div>

      <div className="stack" style={{ "--gap": "6px" } as React.CSSProperties}>
        <strong>Audio size</strong>
        <small className="muted">A Yoto card holds 500 MB. Smaller audio fits more on each card, and spoken word still sounds clear.</small>
        <div className="size-options" role="radiogroup" aria-label="Audio size">
          {opts.map((o) => (
            <button
              key={String(o.kbps)}
              type="button"
              role="radio"
              aria-checked={kbps === o.kbps}
              className={`size-option ${kbps === o.kbps ? "active" : ""}`}
              disabled={o.cards === null}
              onClick={() => setKbps(o.kbps)}
            >
              {o.kbps === recommended ? (
                <span className="size-badge">Recommended</span>
              ) : (
                o.kbps === null && <span className="size-badge plain">Fastest</span>
              )}
              <span className="size-name">{label(o.kbps)}</span>
              <span className="size-cards serif">{o.cards === null ? "Too big" : plural(o.cards, "card")}</span>
              <small className="size-detail tabular">
                {mb(o.bytes)} · {o.kbps ?? options.data?.current_kbps ?? "?"} kbps
              </small>
            </button>
          ))}
        </div>
      </div>

      {several && (
        <div className="grid-2" style={{ alignItems: "start" }}>
          <div className="stack" style={{ "--gap": "6px" } as React.CSSProperties}>
            <strong>Play order</strong>
            <PickOrder order={order} onChange={setOrder} />
          </div>
          <div className="stack" style={{ "--gap": "14px" } as React.CSSProperties}>
            <label className="field">
              <span>Name for the cards</span>
              <input className="input" value={name} placeholder="e.g. Harry Potter" onChange={(e) => setName(e.target.value)} />
              <small>
                {name.trim()
                  ? `They'll be called “${cardTitle(name, 1, Math.max(cards, 2), "")}”, “${cardTitle(name, 2, Math.max(cards, 2), "")}”…`
                  : "Leave blank to name each card after what's on it."}
              </small>
            </label>
            <div className="field">
              <span>How to fill the cards</span>
              <div className="segmented" style={{ alignSelf: "flex-start", flexWrap: "wrap" }}>
                {PACK_STRATEGIES.map((s) => (
                  <button key={s.id} className={strategy === s.id ? "active" : ""} onClick={() => setStrategy(s.id)}>
                    {s.label}
                  </button>
                ))}
              </div>
              <small>{PACK_STRATEGIES.find((s) => s.id === strategy)?.hint}</small>
            </div>
          </div>
        </div>
      )}

      {!yoto.loading && !yoto.connected && (
        <Note tone="info">
          {yoto.ready
            ? "One more thing: connect your Yoto account so we can send it. You'll sign in on Yoto's site and come straight back here."
            : "Yoto isn't switched on for this site yet. Ask whoever invited you to set it up in Settings."}
        </Note>
      )}

      <div className="send-foot">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        {yoto.connected || yoto.loading ? (
          <Button variant="primary" size="lg" icon={<SquareStack size={18} />} disabled={!cards || busy || yoto.loading} loading={busy} onClick={() => void send()}>
            {cards > 1 ? `Send ${cards} cards to Yoto` : "Send to Yoto"}
          </Button>
        ) : (
          yoto.ready && (
            <Button variant="primary" size="lg" icon={<Link2 size={17} />} onClick={() => void connect(returnTo)}>
              Connect Yoto
            </Button>
          )
        )}
      </div>
    </div>
  );
}

const NONE = new Set<string>();

function PickOrder({ order, onChange }: { order: PackGroup[]; onChange: (next: PackGroup[]) => void }) {
  const move = (from: number, to: number) => {
    const next = [...order];
    const [g] = next.splice(from, 1);
    next.splice(to, 0, g);
    onChange(next);
  };
  const keys = order.map((g) => g.key);
  const byKey = new Map(order.map((g) => [g.key, g]));
  const { listRef, handle, rowClass, dragging } = useDragSort(keys, NONE, (next) => onChange(next.map((k) => byKey.get(k)!)));
  return (
    <div className={`list sortable ${dragging ? "is-dragging" : ""}`} ref={listRef}>
      {order.map((g, i) => (
        <div key={g.key} data-sort-row className={`list-row ${rowClass(g.key, i)}`} style={{ gridTemplateColumns: "auto auto 1fr auto" }}>
          <button type="button" className="grip" aria-label={`Drag ${g.title} to reorder`} title="Drag to reorder" {...handle(g.key)}>
            <GripVertical size={16} />
          </button>
          <span className="num tabular">{i + 1}</span>
          <div style={{ minWidth: 0 }}>
            <div className="title truncate">{g.title}</div>
            <div className="sub">{plural(g.track_ids.length, "track")}</div>
          </div>
          <div className="row" style={{ "--gap": "2px" } as React.CSSProperties}>
            <Button size="sm" variant="ghost" iconOnly icon={<ArrowUp size={15} />} aria-label={`Move ${g.title} earlier`} disabled={i === 0} onClick={() => move(i, i - 1)} />
            <Button size="sm" variant="ghost" iconOnly icon={<ArrowDown size={15} />} aria-label={`Move ${g.title} later`} disabled={i === order.length - 1} onClick={() => move(i, i + 1)} />
            <Button size="sm" variant="ghost" iconOnly icon={<X size={15} />} aria-label={`Remove ${g.title}`} disabled={order.length === 1} onClick={() => onChange(order.filter((_, j) => j !== i))} />
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------- the buttons ----------

/** Where a book stands with Yoto, for its buttons. */
function useBookYoto(book: Pick<Book, "id" | "yoto_status">) {
  const job = useActiveJob("book", book.id);
  const sending = job && (job.kind === "yoto_send" || job.kind === "yoto_sync") ? job : undefined;
  const busy = job && !sending ? job : undefined; // downloading or transcribing: wait for that first
  return { sending, busy, onYoto: book.yoto_status === "synced" };
}

/** The book page's button: Send to Yoto, Resend to Yoto, or how far a send has got. */
export function SendToYotoButton({ book, variant = "primary", autoOpen }: { book: Book; variant?: "primary" | "sage" | undefined; autoOpen?: boolean }) {
  const [open, setOpen] = useState(!!autoOpen);
  const { sending, busy, onYoto } = useBookYoto(book);
  useEffect(() => {
    if (autoOpen) setOpen(true);
  }, [autoOpen]);
  return (
    <>
      {sending ? (
        <Button size="lg" variant={variant} loading disabled>
          Sending to Yoto · {Math.round(sending.progress * 100)}%
        </Button>
      ) : (
        <Button
          size="lg"
          variant={onYoto ? undefined : variant}
          icon={onYoto ? <CheckCircle2 size={18} /> : <SquareStack size={18} />}
          disabled={!!busy}
          title={busy ? "Wait for the download to finish" : undefined}
          onClick={() => setOpen(true)}
        >
          {onYoto ? "Resend to Yoto" : "Send to Yoto"}
        </Button>
      )}
      {open && <SendToYoto source={{ kind: "book", book }} returnTo={`/books/${book.id}?send=1`} onClose={() => setOpen(false)} />}
    </>
  );
}

/** The Yoto button under a cover in a grid: for a book, show or folder. */
export function CardYotoFooter({ source, book }: { source: SendSource; book?: Book }) {
  const [open, setOpen] = useState(false);
  const fallback = { id: -1, yoto_status: "" as const };
  const { sending, busy, onYoto } = useBookYoto(book ?? fallback);
  const returnTo = book ? `/books/${book.id}?send=1` : source.kind === "podcast" ? `/podcasts/${source.id}` : source.kind === "folder" ? `/folders/${source.id}` : "/yoto";
  return (
    <>
      {sending ? (
        <div className="card-ask working" title={sending.message || sending.title}>
          <span className="card-ask-fill" style={{ width: `${Math.round(sending.progress * 100)}%` }} />
          <SquareStack size={14} /> Sending {Math.round(sending.progress * 100)}%
        </div>
      ) : (
        <button type="button" className={`card-ask ${onYoto ? "done" : "yoto"}`} disabled={!!busy} onClick={() => setOpen(true)}>
          {onYoto ? <CheckCircle2 size={14} /> : <SquareStack size={14} />} {onYoto ? "On Yoto" : "Send to Yoto"}
        </button>
      )}
      {open && <SendToYoto source={source} returnTo={returnTo} onClose={() => setOpen(false)} />}
    </>
  );
}

/** For pages that only need to know whether a meter is past full. */
export function CardFill({ bytes, cardBytes = 500 * 1024 * 1024 }: { bytes: number; cardBytes?: number }) {
  const fill = bytes / cardBytes;
  return (
    <>
      <Meter value={fill} />
      <div className="muted tabular" style={{ fontSize: "var(--text-xs)", marginTop: 4 }}>
        {Math.round(fill * 100)}% of a card
      </div>
    </>
  );
}
