import { useQuery } from "@tanstack/react-query";
import {
  BookOpen,
  Check,
  CheckCircle2,
  CircleCheckBig,
  FileText,
  Folder,
  Headphones,
  Hourglass,
  Mic,
  Plus,
  RefreshCw,
  Search,
  Star,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api";
import {
  ContinueListening,
  CoverGrid,
  GridSkeleton,
  YotoRail,
  useLibraryItems,
  type LibraryItem,
} from "../components/LibraryGrid";
import { Button, Empty, PageHead, useToast } from "../components/ui";
import { relative } from "../format";
import { useListMemory, useUpdateParams } from "../hooks/listMemory";
import { useAction } from "../hooks/queries";
import type { AudibleAccount, Playlist } from "../types";

type Kind = "all" | "books" | "podcasts" | "local";

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
    label: "Has transcript",
    icon: <FileText size={15} />,
    test: (i) => !!i.transcribed,
  },
  {
    key: "mp3",
    label: "MP3 ready",
    icon: <CheckCircle2 size={15} />,
    test: (i) => !!i.ready,
  },
  {
    key: "listening",
    label: "In progress",
    icon: <Hourglass size={15} />,
    test: (i) => !!i.inProgress,
    booksOnly: true,
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
  const navigate = useNavigate();
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
  useListMemory(!library.loading);
  const sync = useAction((id: number) => api.post(`/audible/accounts/${id}/sync`), [["books"]]);

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
  const setKind = (k: Kind) => setParam("kind", k === "all" ? "" : k);
  const toggleFilter = (key: string) => update((p) => (p.get(key) === "1" ? p.delete(key) : p.set(key, "1")));
  // Book-only filters are hidden where there are no books to apply them to.
  const hasBooks = inView.some((i) => i.kind === "book");
  const shown = FILTERS.filter((f) => !f.booksOnly || hasBooks || active.includes(f));

  return (
    <>
      <PageHead
        title={account ? `${account.name}'s library` : "Your listening library"}
        lede={
          account
            ? `${account.book_count} titles on Audible · synced ${relative(account.last_synced_at)}`
            : "Everything everyone has added, in one place."
        }
        actions={
          <>
            <div className="search">
              <Search size={17} />
              <input className="input" type="search" placeholder="Search your audio…" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            {account ? (
              <Button
                icon={<RefreshCw size={16} />}
                loading={sync.isPending}
                onClick={() =>
                  sync.mutate(account.id, {
                    onSuccess: () => toast("Syncing library from Audible…"),
                  })
                }
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
