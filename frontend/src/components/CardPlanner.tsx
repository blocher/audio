import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Clock, CornerDownRight, GripVertical, HardDrive, SquareStack, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { bytes, duration } from "../format";
import { useDragSort } from "../hooks/dragSort";
import { useAction } from "../hooks/queries";
import type { PackGroup, PackPreview, PackStrategy, Playlist, SettingsData } from "../types";
import { BitratePicker } from "./Tools";
import { Button, Meter, Modal, Note, Spinner, errorText, useToast } from "./ui";

export const PACK_STRATEGIES: { id: PackStrategy; label: string; hint: string }[] = [
  {
    id: "continuous",
    label: "Back to back",
    hint: "Plays everything in order. When one book ends partway through a card, the next starts on the same card.",
  },
  { id: "sequential", label: "New card per source", hint: "Plays everything in order, and each book or show starts on its own card." },
  {
    id: "compact",
    label: "Keep shows whole",
    hint: "Short shows each stay whole on one card and may share it with others, so the cards aren't strictly in order.",
  },
];

/** "Name (3 of 24)" when the set has a name; otherwise the packer's own title. */
export function cardTitle(name: string, n: number, total: number, fallback: string) {
  const trimmed = name.trim();
  if (!trimmed) return fallback;
  return total === 1 ? trimmed : `${trimmed} (${n} of ${total})`;
}

/** A sensible name for several sources: their shared series, else the words their titles start with. */
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

export function PackResult({ preview, name = "" }: { preview: PackPreview; name?: string }) {
  const total = preview.cards.length;
  return (
    <div className="plan-grid">
      {preview.cards.map((card, n) => (
        <div key={n} className="yoto-card">
          <div className="card-art">
            <SquareStack size={22} />
            <span className="n">#{n + 1}</span>
          </div>
          <div style={{ minWidth: 0 }}>
            <div className="truncate" style={{ fontWeight: 650 }}>
              {cardTitle(name, n + 1, total, card.title)}
            </div>
            <div className="muted tabular" style={{ fontSize: "var(--text-xs)", margin: "2px 0 8px" }}>
              {card.track_count} tracks · {duration(card.duration_ms)} · {bytes(card.bytes)}
            </div>
            <Meter value={card.fill} />
            <div className="muted" style={{ fontSize: "var(--text-xs)", marginTop: 5 }}>
              {Math.round(card.fill * 100)}% full · limited by {card.bound_by === "time" ? "the 5-hour cap" : "500 MB"}
            </div>
            {card.segments.length > 1 && (
              <div className="stack" style={{ "--gap": "2px", marginTop: 6, fontSize: "var(--text-xs)" } as React.CSSProperties}>
                {card.segments.map((s, i) => (
                  <div key={i} className="row muted" style={{ "--gap": "4px", minWidth: 0 } as React.CSSProperties}>
                    {i > 0 && <CornerDownRight size={11} style={{ flexShrink: 0 }} />}
                    <span className="truncate">
                      {s.title} · {s.count} track{s.count === 1 ? "" : "s"}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

const NONE = new Set<string>();

function SourceOrder({ order, onChange }: { order: PackGroup[]; onChange: (next: PackGroup[]) => void }) {
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
            <div className="sub">
              {g.track_ids.length} track{g.track_ids.length === 1 ? "" : "s"}
            </div>
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

export default function CardPlanner({
  groups,
  coverUrl,
  onClose,
}: {
  groups: PackGroup[];
  coverUrl?: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const navigate = useNavigate();
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api.get<SettingsData>("/settings") });
  const [order, setOrder] = useState(groups);
  const [name, setName] = useState(() => suggestName(groups));
  const [kbps, setKbps] = useState<number | null>(null);
  const [mono, setMono] = useState(true);
  const [strategy, setStrategy] = useState<PackStrategy>(groups.length > 1 ? "continuous" : "sequential");
  const [enforceHours, setEnforceHours] = useState(false);
  // The length limit from Settings (0 = off); ticking the box with it off falls back to Yoto's documented 5 hours.
  const prefHours = settings.data?.preferences.card_limit_hours ?? 0;
  const limitHours = prefHours > 0 ? prefHours : 5;
  const limitMb = settings.data?.preferences.card_limit_mb || 500;

  useEffect(() => {
    if (!settings.data) return;
    const pref = settings.data.preferences.pack_strategy;
    // With several sources, "new card per source" is never fewer cards than back to back; it's only a preference.
    setStrategy(groups.length > 1 && pref === "sequential" ? "continuous" : pref);
    setEnforceHours(settings.data.preferences.card_limit_hours > 0);
  }, [settings.data, groups.length]);

  const several = order.length > 1;
  const body = {
    groups: order,
    strategy,
    kbps,
    mono,
    use_optimized: true,
    max_hours: enforceHours ? limitHours : 0,
  };
  const preview = useQuery({
    queryKey: ["pack", JSON.stringify(body)],
    queryFn: () => api.post<PackPreview>("/pack/preview", body),
    enabled: order.some((g) => g.track_ids.length > 0),
    placeholderData: (prev) => prev,
  });
  const create = useAction(
    () =>
      api.post<{ batch: string; playlists: Playlist[] }>("/yoto/playlists/from-pack", {
        ...body,
        name: several ? name : "",
        cover_url: coverUrl ?? "",
        downsize_first: kbps !== null,
      }),
    [["playlists"]],
  );
  const cards = preview.data?.cards.length ?? 0;
  const trackCount = order.reduce((a, g) => a + g.track_ids.length, 0);
  const hint = PACK_STRATEGIES.find((s) => s.id === strategy)?.hint;

  return (
    <Modal
      wide
      title="Make Yoto cards"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={<SquareStack size={17} />}
            disabled={!cards || preview.isFetching}
            loading={create.isPending}
            onClick={() =>
              create.mutate(undefined, {
                onSuccess: (res) => {
                  toast(`Created ${res.playlists.length} playlist${res.playlists.length === 1 ? "" : "s"}${kbps ? " — downsizing first" : ""}`);
                  onClose();
                  navigate(`/yoto?batch=${res.batch}`);
                },
                onError: (e) => toast(errorText(e), "error"),
              })
            }
          >
            Create {cards || ""} playlist{cards === 1 ? "" : "s"}
          </Button>
        </>
      }
    >
      <div className="stack" style={{ "--gap": "20px" } as React.CSSProperties}>
        <p className="muted">
          {trackCount} track{trackCount === 1 ? "" : "s"} from {several ? `${order.length} sources` : order[0].title}. Each Yoto card holds up to 100 tracks
          and {limitMb} MB; tracks over an hour are split into parts.
        </p>

        {several && (
          <div className="grid-2" style={{ alignItems: "start" }}>
            <div className="stack" style={{ "--gap": "6px" } as React.CSSProperties}>
              <strong>Play order</strong>
              <SourceOrder order={order} onChange={setOrder} />
            </div>
            <label className="field">
              <span>Name for the set</span>
              <input className="input" value={name} placeholder="e.g. Harry Potter" onChange={(e) => setName(e.target.value)} />
              <small>
                {name.trim()
                  ? `Cards will be called “${cardTitle(name, 1, Math.max(cards, 2), "")}”, “${cardTitle(name, 2, Math.max(cards, 2), "")}”…`
                  : "Leave blank to name each card after what's on it."}
              </small>
            </label>
          </div>
        )}

        <div className="stack">
          <strong>Audio size</strong>
          <BitratePicker kbps={kbps} mono={mono} onChange={(k, m) => (setKbps(k), setMono(m))} allowOriginal />
        </div>

        <div className="stack" style={{ "--gap": "6px" } as React.CSSProperties}>
          <div className="row wrap" style={{ "--gap": "18px" } as React.CSSProperties}>
            <div className="stack" style={{ "--gap": "6px" } as React.CSSProperties}>
              <strong>Packing</strong>
              <div className="segmented">
                {PACK_STRATEGIES.map((s) => (
                  <button key={s.id} className={strategy === s.id ? "active" : ""} onClick={() => setStrategy(s.id)}>
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
            <label className="check" style={{ marginTop: 22 }}>
              <input type="checkbox" checked={enforceHours} onChange={(e) => setEnforceHours(e.target.checked)} />
              Limit each card to {limitHours} hours
            </label>
          </div>
          {several && <small className="muted">{hint}</small>}
        </div>

        {kbps === null && (
          <Note tone="info">
            Yoto re-encodes everything you upload, and its 5-hour cap usually binds before 500 MB. Downsizing mainly makes uploads
            faster and saves server space; it fits more per card only when files are large.
          </Note>
        )}

        {preview.isLoading ? (
          <Spinner />
        ) : preview.isError ? (
          <Note tone="error">{errorText(preview.error)}</Note>
        ) : preview.data ? (
          <div className="stack" style={{ "--gap": "12px", opacity: preview.isFetching ? 0.6 : 1 } as React.CSSProperties}>
            <div className="row wrap" style={{ "--gap": "18px" } as React.CSSProperties}>
              <span className="serif" style={{ fontSize: "var(--text-2xl)", fontWeight: 600 }}>
                {cards} card{cards === 1 ? "" : "s"}
              </span>
              <span className="row muted">
                <Clock size={15} /> {duration(preview.data.total_duration_ms)}
              </span>
              <span className="row muted">
                <HardDrive size={15} /> {bytes(preview.data.total_bytes)}
              </span>
            </div>
            <PackResult preview={preview.data} name={several ? name : ""} />
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
