import { Hourglass, Star } from "lucide-react";
import { Link } from "react-router-dom";
import { CoverGrid, GridSkeleton, useLibraryItems, type LibraryItem } from "../components/LibraryGrid";
import { Empty, PageHead } from "../components/ui";
import { useListMemory } from "../hooks/listMemory";

/** Just yours: what you've starred, and the audiobooks you're partway through. */
export default function Shelf() {
  const library = useLibraryItems();
  useListMemory(!library.loading);
  const starred = library.items.filter((i) => i.starredAt).sort((a, b) => b.starredAt!.localeCompare(a.starredAt!));
  const partway = library.items
    .filter((i) => i.inProgress && !i.starredAt)
    .sort((a, b) => (b.progress ?? 0) - (a.progress ?? 0));
  return (
    <>
      <PageHead title="My Shelf" lede="What you've starred and what you're partway through. Just yours; everyone has their own." />
      {library.loading ? (
        <GridSkeleton count={6} />
      ) : !starred.length && !partway.length ? (
        <Empty
          icon={<Star size={38} />}
          title="Your shelf is empty"
          action={
            <Link className="btn primary" to="/library">
              Go to Library
            </Link>
          }
        >
          Tap the <Star size={14} style={{ verticalAlign: "-2px" }} /> on any book, podcast or folder to keep it here. Audiobooks
          you're partway through on Audible show up here too.
        </Empty>
      ) : (
        <>
          <ShelfSection icon={<Star size={18} />} title="Starred" items={starred} empty="Tap the star on anything in your library to keep it here." />
          <ShelfSection icon={<Hourglass size={18} />} title="Partway through" items={partway} empty="Audiobooks you've started on Audible show up here." />
        </>
      )}
    </>
  );
}

function ShelfSection({ icon, title, items, empty }: { icon: React.ReactNode; title: string; items: LibraryItem[]; empty: string }) {
  return (
    <section className="shelf-section">
      <div className="section-head">
        {icon}
        <h2>{title}</h2>
        {items.length > 0 && <span className="muted tabular">{items.length}</span>}
      </div>
      {items.length ? <CoverGrid items={items} /> : <p className="muted">{empty}</p>}
    </section>
  );
}
