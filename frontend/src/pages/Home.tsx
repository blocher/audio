import { useQuery } from "@tanstack/react-query";
import { ArrowRight, LibraryBig, MessageCircle, Search, SquareStack, Star } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import {
  ContinueListening,
  CoverGrid,
  GridSkeleton,
  YotoRail,
  useLibraryItems,
  type LibraryItem,
} from "../components/LibraryGrid";
import { Empty, PageHead, SourceIcon } from "../components/ui";
import { featureSet, useFeatures, useOnboarding } from "../hooks/session";
import { useListMemory } from "../hooks/listMemory";
import type { Playlist, Session } from "../types";

/**
 * The signed-in user's own page, shaped by how they use the site: someone with no Yoto cards yet gets a guide to
 * their first one, with their books right there; someone who asks about books sees what's ready to ask; and
 * everyone sees what they've starred and what they're partway through.
 */
export default function Home() {
  const session = useQuery({
    queryKey: ["session"],
    queryFn: () => api.get<Session>("/auth/session"),
    staleTime: Infinity,
  });
  const playlists = useQuery({
    queryKey: ["playlists"],
    queryFn: () => api.get<Playlist[]>("/yoto/playlists"),
  });
  const library = useLibraryItems();
  const has = useFeatures();
  useListMemory(!library.loading);
  const user = session.data?.user;
  const name = user?.first_name || user?.username || "";

  const starred = library.items.filter((i) => i.starredAt).sort((a, b) => b.starredAt!.localeCompare(a.starredAt!));
  const listening = library.items.filter((i) => i.inProgress && !i.starredAt).slice(0, 6);
  const askable = library.items.filter((i) => i.kind === "book" && i.transcribed && !i.starredAt).slice(0, 6);
  const recent = [...library.items]
    .filter((i) => !i.starredAt)
    .sort((a, b) => b.sortDate.localeCompare(a.sortDate))
    .slice(0, 6);
  const firstCard = has("yoto") && !playlists.isLoading && !(playlists.data ?? []).length && library.items.length > 0;
  const asker = has("ask") && askable.length > 0;
  const empty = !library.loading && !library.items.length;

  return (
    <>
      <PageHead
        title={name ? `Hello, ${name}` : "Hello"}
        lede={
          empty
            ? "Let's bring in your audio first."
            : firstCard
              ? "Let's make your first Yoto card. It takes one tap."
              : asker
                ? "Pick up where you left off, or ask about a book."
                : "Your starred audio and what you're partway through."
        }
        actions={
          !empty &&
          !firstCard &&
          (has("yoto") || has("ask")) && (
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              {has("yoto") && (
                <Link className="btn primary" to="/library?kind=books">
                  <SquareStack size={17} /> Send a book to Yoto
                </Link>
              )}
              {has("ask") && (
                <Link className={`btn ${has("yoto") ? "" : "primary"}`} to="/library?listening=1">
                  <MessageCircle size={17} /> Ask about a book
                </Link>
              )}
            </div>
          )
        }
      />
      <SetupNudge />
      {empty ? (
        <GetStarted />
      ) : (
        <div className="with-rail">
          <section>
            {firstCard && <FirstCardGuide items={library.items} />}
            {library.loading ? (
              <GridSkeleton count={4} />
            ) : (
              <>
                {starred.length > 0 && (
                  <Section title="Starred" count={starred.length} more={{ to: "/library?starred=1", label: "Show in library" }}>
                    <CoverGrid items={starred} />
                  </Section>
                )}
                {asker && <Section title="Ready to ask" items={askable} more={{ to: "/library?transcribed=1", label: "All you can ask about" }} />}
                {listening.length > 0 && (
                  <Section title="Partway through" items={listening} more={{ to: "/library?listening=1", label: "All in progress" }} />
                )}
                {!firstCard && recent.length > 0 && (
                  <Section title="Recently added" items={recent} more={{ to: "/library", label: "Whole library" }} />
                )}
                {!firstCard && !starred.length && (
                  <p className="muted" style={{ fontSize: "var(--text-sm)", marginTop: 18 }}>
                    <Star size={14} style={{ verticalAlign: "-2px" }} /> Tip: tap the star on any book, podcast or folder to keep it at the top of this
                    page. Stars are yours alone.
                  </p>
                )}
              </>
            )}
          </section>
          <aside className="rail">
            <ContinueListening />
            <YotoRail playlists={playlists.data ?? []} loading={playlists.isLoading} />
          </aside>
        </div>
      )}
    </>
  );
}

/** No Yoto cards yet: the three steps, and their books right here, each with its Send to Yoto button. */
function FirstCardGuide({ items }: { items: LibraryItem[] }) {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const books = items
    .filter((i) => i.kind === "book" || i.ready)
    .filter((i) => !needle || `${i.title} ${i.by}`.toLowerCase().includes(needle))
    .sort((a, b) => Number(!!b.inProgress) - Number(!!a.inProgress) || b.sortDate.localeCompare(a.sortDate))
    .slice(0, 8);
  return (
    <section className="panel first-card">
      <div className="eyebrow">Your first Yoto card</div>
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
      <div className="search" style={{ margin: "16px 0", maxWidth: 360 }}>
        <Search size={17} />
        <input className="input" type="search" placeholder="Find a book…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {books.length ? <CoverGrid items={books} /> : <p className="muted">Nothing matches “{q}”.</p>}
      <Link to="/library" className="row" style={{ marginTop: 14, fontWeight: 600 }}>
        See your whole library <ArrowRight size={16} />
      </Link>
    </section>
  );
}

/** Nothing in the library yet: the ways in. */
function GetStarted() {
  return (
    <Empty
      icon={<LibraryBig size={40} />}
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

function Section({
  title,
  count,
  items,
  more,
  children,
}: {
  title: string;
  count?: number;
  items?: LibraryItem[];
  more?: { to: string; label: string };
  children?: React.ReactNode;
}) {
  return (
    <section className="home-section">
      <div className="section-head">
        <h2>{title}</h2>
        {count ? <span className="muted tabular">{count}</span> : null}
        {more && <Link to={more.to}>{more.label} →</Link>}
      </div>
      {children ?? (items && <CoverGrid items={items} />)}
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
  ].filter(Boolean) as { step: string; icon: React.ReactNode; label: string; why: string }[];
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
