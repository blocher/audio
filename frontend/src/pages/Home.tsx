import { useQuery } from "@tanstack/react-query";
import { Star } from "lucide-react";
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
import { Empty, PageHead } from "../components/ui";
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
      <PageHead title={name ? `Hello, ${name}` : "Hello"} lede="Your starred audio, kept here just for you." />
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
