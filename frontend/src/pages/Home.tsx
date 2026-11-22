import { useQuery } from "@tanstack/react-query";
import { ArrowRight, MessageCircle, SquareStack, Star } from "lucide-react";
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

/** The signed-in user's own page: what they've starred first, then what they're partway through. */
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
  const recent = [...library.items]
    .filter((i) => !i.starredAt)
    .sort((a, b) => b.sortDate.localeCompare(a.sortDate))
    .slice(0, 6);

  return (
    <>
      <PageHead
        title={name ? `Hello, ${name}` : "Hello"}
        lede="Your starred audio, kept here just for you."
        actions={
          (has("yoto") || has("ask")) && (
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              {has("yoto") && (
                <Link className="btn primary" to="/yoto?new=1">
                  <SquareStack size={17} /> Make Yoto cards
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
      <div className="with-rail">
        <section>
          <Section
            title="Starred"
            count={starred.length}
            more={starred.length ? { to: "/library?starred=1", label: "Show in library" } : undefined}
          >
            {library.loading ? (
              <GridSkeleton count={4} />
            ) : starred.length ? (
              <CoverGrid items={starred} />
            ) : (
              <Empty icon={<Star size={36} />} title="Nothing starred yet">
                Tap the <Star size={14} style={{ verticalAlign: "-2px" }} /> on any book, podcast or folder to keep it here. Stars
                are yours alone; everyone else keeps their own.
              </Empty>
            )}
          </Section>
          {listening.length > 0 && (
            <Section title="Partway through" items={listening} more={{ to: "/library?listening=1", label: "All in progress" }} />
          )}
          {recent.length > 0 && (
            <Section title="Recently added" items={recent} more={{ to: "/library", label: "Whole library" }} />
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
