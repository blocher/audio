import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  BookOpen,
  MessageCircle,
  SquareStack,
  X,
  Check,
  CheckCircle2,
  CircleCheckBig,
  FileText,
  Folder,
  Headphones,
  Hourglass,
  Mic,
  RefreshCw,
  Search,
  Star,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api";
import {
  ContinueListening,
  CoverGrid,
  GridSkeleton,
  YotoRail,
  useLibraryItems,
  type LibraryItem,
} from "../components/LibraryGrid";
import { Button, Empty, PageHead, SourceIcon, errorText, useToast } from "../components/ui";
import { relative } from "../format";
import { useListMemory, useUpdateParams } from "../hooks/listMemory";
import { featureSet, useFeatures, useOnboarding } from "../hooks/session";
import { useAction, useJobs } from "../hooks/queries";
import type { AudibleAccount, Playlist } from "../types";

type Kind = "all" | "books" | "podcasts" | "local";

const KIND_TITLES: Record<Kind, string> = { all: "Library", books: "Audiobooks", podcasts: "Podcasts", local: "My own files" };

/** Library filters, each kept in the URL so a filtered view can be bookmarked or shared. */
const FILTERS: {
  key: string;
  label: string;
  icon: ReactNode;
  test: (i: LibraryItem) => boolean;
  booksOnly?: boolean;
}[] = [
  {
    key: "starred",
    label: "Starred",
    icon: <Star size={15} />,
    test: (i) => !!i.starredAt,
  },
  {
    key: "transcribed",
    label: "Ready to ask",
    icon: <FileText size={15} />,
    test: (i) => !!i.transcribed,
  },
  {
    key: "mp3",
    label: "Downloaded",
    icon: <CheckCircle2 size={15} />,
    test: (i) => !!i.ready,
  },
  {
    key: "listening",
    label: "In progress",
    icon: <Hourglass size={15} />,
    test: (i) => !!i.inProgress,
  },
  {
    key: "finished",
    label: "Finished",
    icon: <CircleCheckBig size={15} />,
    test: (i) => !!i.finished,
    booksOnly: true,
  },
];

export default function Library() {
  const [params] = useSearchParams();
  const update = useUpdateParams();
  const toast = useToast();
  const kind = (params.get("kind") as Kind) || "all";
  const accountId = params.get("account");
  const active = FILTERS.filter((f) => params.get(f.key) === "1");
  // Search and sort live in the URL with the tab and filters, so Back (or the book's "← Library") returns to them.
  // Each change builds on the latest URL, so quick taps in a row don't undo each other.
  const setParam = (key: string, value: string) => update((p) => (value ? p.set(key, value) : p.delete(key)));
  // The box keeps its own text so fast typing never waits on the URL; Back puts the URL's text back in it.
  const urlQ = params.get("q") ?? "";
  const [q, setQText] = useState(urlQ);
  useEffect(() => setQText(urlQ), [urlQ]);
  const setQ = (value: string) => {
    setQText(value);
    setParam("q", value);
  };
  const sort = (["title", "progress"] as const).find((s) => s === params.get("sort")) ?? "recent";
  const setSort = (value: "recent" | "title" | "progress") => setParam("sort", value === "recent" ? "" : value);

  const accounts = useQuery({
    queryKey: ["audible-accounts"],
    queryFn: () => api.get<AudibleAccount[]>("/audible/accounts"),
  });
  const playlists = useQuery({
    queryKey: ["playlists"],
    queryFn: () => api.get<Playlist[]>("/yoto/playlists"),
  });
  const library = useLibraryItems();
  const has = useFeatures();
  useListMemory(!library.loading);
  // Refresh: get the latest from Audible (this account's, or every connected one's), then say what changed.
  const sync = useAction((id: number | null) => api.post(id ? `/audible/accounts/${id}/sync` : "/audible/sync"), [["books"]]);
  const jobs = useJobs();
  const syncing = (jobs.data ?? []).some((j) => j.kind === "audible_sync" && (j.status === "queued" || j.status === "running"));
  const connectedAccounts = (accounts.data ?? []).filter((a) => a.connected);
  const lastChecked = connectedAccounts.map((a) => a.last_synced_at).filter(Boolean).sort()[0] ?? null;
  // A check you asked for always reports back; the quiet one on opening the page only speaks up when there's news.
  const asked = useRef(false);
  const watchedSyncs = useRef<Set<number> | null>(null);
  useEffect(() => {
    if (!jobs.data) return;
    const syncs = jobs.data.filter((j) => j.kind === "audible_sync");
    for (const j of syncs) {
      const news = !j.message.startsWith("nothing new");
      if (watchedSyncs.current?.has(j.id) && j.status === "succeeded" && (asked.current || news)) {
        const name = accounts.data?.find((a) => a.id === j.target_id)?.name;
        toast(`${name ? `${name}'s Audible` : "Audible"}: ${j.message}`);
      }
    }
    const active = syncs.filter((j) => j.status === "queued" || j.status === "running").map((j) => j.id);
    if (watchedSyncs.current?.size && !active.length) asked.current = false;
    watchedSyncs.current = new Set(active);
  }, [jobs.data, accounts.data, toast]);
  const refresh = () => {
    asked.current = true;
    sync.mutate(account ? account.id : null, {
      onSuccess: () => toast("Checking Audible for anything new…"),
      onError: (e) => toast(errorText(e), "error"),
    });
  };
  // Opening the Library checks Audible quietly when it hasn't been checked in the last hour (the server keeps count).
  const checkedOnOpen = useRef(false);
  const quietCheck = useAction(() => api.post("/audible/sync?if_older_than_minutes=60"));
  useEffect(() => {
    if (checkedOnOpen.current || !connectedAccounts.length) return;
    checkedOnOpen.current = true;
    const hourAgo = Date.now() - 60 * 60 * 1000;
    if (connectedAccounts.some((a) => !a.last_synced_at || Date.parse(a.last_synced_at) < hourAgo)) quietCheck.mutate();
  }, [connectedAccounts, quietCheck]);

  // Everything in the current tab and account, before search and the filters.
  const inView = useMemo(() => {
    const kindMap: Record<Kind, LibraryItem["kind"] | null> = {
      all: null,
      books: "book",
      podcasts: "podcast",
      local: "folder",
    };
    return library.items.filter(
      (i) => (!kindMap[kind] || i.kind === kindMap[kind]) && (!accountId || (i.accountIds ?? []).some((a) => String(a) === accountId)),
    );
  }, [library.items, kind, accountId]);

  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const filtered = inView.filter(
      (i) => (!needle || `${i.title} ${i.by}`.toLowerCase().includes(needle)) && active.every((f) => f.test(i)),
    );
    filtered.sort((a, b) =>
      sort === "title"
        ? a.title.localeCompare(b.title)
        : sort === "progress"
          ? (b.progress ?? 0) - (a.progress ?? 0)
          : b.sortDate.localeCompare(a.sortDate),
    );
    return filtered;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inView, q, sort, params]);

  const counts = {
    all: library.items.length,
    books: library.books.length,
    podcasts: library.podcasts.length,
    local: library.folders.length,
  };
  const account = accounts.data?.find((a) => String(a.id) === accountId);
  const noCards = !playlists.isLoading && !(playlists.data ?? []).length;
  const setKind = (k: Kind) => setParam("kind", k === "all" ? "" : k);
  const toggleFilter = (key: string) => update((p) => (p.get(key) === "1" ? p.delete(key) : p.set(key, "1")));
  // Book-only filters are hidden where there are no books to apply them to.
  const hasBooks = inView.some((i) => i.kind === "book");
  const shown = FILTERS.filter((f) => !f.booksOnly || hasBooks || active.includes(f));

  return (
    <>
      <PageHead
        title={account ? `${account.name}'s library` : KIND_TITLES[kind]}
        lede={
          account
            ? `${account.book_count} titles on Audible · synced ${relative(account.last_synced_at)}`
            : has("yoto")
              ? "Tap Send to Yoto under anything here to put it on a Yoto card."
              : "Everything everyone in your home has added, in one place."
        }
        actions={
          <>
            <div className="search">
              <Search size={17} />
              <input className="input" type="search" placeholder="Search your audio…" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            {(account || ((kind === "all" || kind === "books") && connectedAccounts.length > 0)) && (
              <Button
                icon={<RefreshCw size={16} />}
                loading={sync.isPending || syncing}
                onClick={refresh}
                title={`Get the latest from Audible${lastChecked ? ` (last checked ${relative(lastChecked)})` : ""}`}
              >
                {syncing ? "Refreshing" : "Refresh"}
              </Button>
            )}
            <Link className="btn" to="/shelf">
              <Star size={16} /> My Shelf
            </Link>
          </>
        }
      />

      <SetupNudge />
      {has("yoto") && noCards && counts.all > 0 && <FirstCardStrip />}
      <div className="with-rail">
        <section>
          <div className="toolbar">
            <div className="chips">
              {(
                [
                  ["all", "All audio", null],
                  ["books", "Audiobooks", <BookOpen size={16} key="b" />],
                  ["podcasts", "Podcasts", <Mic size={16} key="p" />],
                  ["local", "My own files", <Folder size={16} key="l" />],
                ] as const
              ).map(([k, label, icon]) => (
                <button key={k} className={`chip ${kind === k ? "active" : ""}`} onClick={() => setKind(k)}>
                  {icon}
                  {label} <span className="n">{counts[k]}</span>
                </button>
              ))}
            </div>
            <div className="chips filter-chips" role="group" aria-label="Filter audio">
              {shown.map((f) => {
                const on = active.includes(f);
                return (
                  <button
                    key={f.key}
                    className={`chip toggle ${on ? "active" : ""}`}
                    aria-pressed={on}
                    onClick={() => toggleFilter(f.key)}
                  >
                    {on ? <Check size={15} /> : f.icon}
                    {f.label} <span className="n">{inView.filter(f.test).length}</span>
                  </button>
                );
              })}
            </div>
            <span className="spacer" />
            <div className="segmented" role="group" aria-label="Sort">
              {(["recent", "title", "progress"] as const).map((s) => (
                <button key={s} className={sort === s ? "active" : ""} onClick={() => setSort(s)}>
                  {s === "recent" ? "Recent" : s === "title" ? "A–Z" : "Progress"}
                </button>
              ))}
            </div>
          </div>

          {library.loading ? (
            <GridSkeleton />
          ) : items.length ? (
            <CoverGrid items={items} />
          ) : counts.all ? (
            <Empty icon={<Search size={34} />} title="Nothing matches">
              {active.some((f) => f.key === "starred")
                ? "Star a book, podcast or folder to find it here."
                : "Try a different search or filter."}
            </Empty>
          ) : (
            <GetStarted />
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

const DISMISSED = "audio.firstCardStrip";

/** No Yoto cards yet: how to make one, pointing at the covers right below. Closes for good once dismissed. */
function FirstCardStrip() {
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(DISMISSED) === "1";
    } catch {
      return false;
    }
  });
  if (hidden) return null;
  const close = () => {
    setHidden(true);
    try {
      localStorage.setItem(DISMISSED, "1");
    } catch {
      /* storage unavailable: it just comes back next time */
    }
  };
  return (
    <section className="panel first-card">
      <div className="row" style={{ alignItems: "flex-start" }}>
        <div className="eyebrow" style={{ flex: 1 }}>
          Make your first Yoto card
        </div>
        <Button size="sm" variant="ghost" iconOnly icon={<X size={16} />} aria-label="Hide this" onClick={close} />
      </div>
      <ol className="howto-steps">
        <li className="current">
          <span className="howto-n">1</span>
          <span>
            Pick a book below and tap <b>Send to Yoto</b>
          </span>
        </li>
        <li>
          <span className="howto-n">2</span>
          <span>We download it and fit it onto as few cards as possible</span>
        </li>
        <li>
          <span className="howto-n">3</span>
          <span>
            In the <b>Yoto app</b>, open Library and link it to a blank card
          </span>
        </li>
      </ol>
    </section>
  );
}

/** A short "still to do" card while something this person needs isn't connected yet. */
function SetupNudge() {
  const status = useOnboarding();
  const data = status.data;
  if (!data) return null;
  const has = featureSet(data.features);
  const todo = [
    has.has("audible") &&
      !data.audible.some((a) => a.connected) && {
        step: "audible",
        icon: <SourceIcon kind="audible" size={18} />,
        label: "Connect Audible",
        why: "to see your audiobooks",
      },
    has.has("yoto") &&
      !data.yoto.connected.length &&
      data.yoto.ready && { step: "yoto", icon: <SquareStack size={18} />, label: "Connect Yoto", why: "to send cards to your player" },
    has.has("ask") &&
      !(data.ai.transcribe && data.ai.ask) && {
        step: "ai",
        icon: <MessageCircle size={18} />,
        label: "Set up Ask",
        why: "to ask questions about books",
      },
  ].filter(Boolean) as { step: string; icon: ReactNode; label: string; why: string }[];
  if (!todo.length) return null;
  return (
    <section className="panel setup-nudge">
      <strong>Finish setting up</strong>
      <div className="setup-nudge-items">
        {todo.map((t) => (
          <Link key={t.step} to={`/welcome?step=${t.step}`} className="setup-nudge-item">
            {t.icon}
            <span>
              <b>{t.label}</b> <span className="muted">{t.why}</span>
            </span>
            <ArrowRight size={16} />
          </Link>
        ))}
      </div>
    </section>
  );
}

/** Nothing in the library yet: the ways in. */
function GetStarted() {
  return (
    <Empty
      icon={<Headphones size={40} />}
      title="Your library is empty"
      action={
        <div className="row wrap" style={{ gap: 10, justifyContent: "center" }}>
          <Link className="btn primary" to="/welcome?step=audible">
            <SourceIcon kind="audible" size={16} /> Connect Audible
          </Link>
          <Link className="btn" to="/podcasts">
            Follow a podcast
          </Link>
          <Link className="btn" to="/folders">
            Add my own files
          </Link>
        </div>
      }
    >
      Bring in the audiobooks you own on Audible, podcasts you follow, or audio files from your computer.
    </Empty>
  );
}
