import { useQuery } from "@tanstack/react-query";
import { Clock, HardDrive, Layers, SquareStack } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { bytes, duration } from "../format";
import { useAction } from "../hooks/queries";
import type { PackGroup, PackPreview, Playlist, SettingsData } from "../types";
import { BitratePicker } from "./Tools";
import { Button, Meter, Modal, Note, Spinner, errorText, useToast } from "./ui";

export function PackResult({ preview }: { preview: PackPreview }) {
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
              {card.title}
            </div>
            <div className="muted tabular" style={{ fontSize: "var(--text-xs)", margin: "2px 0 8px" }}>
              {card.track_count} tracks · {duration(card.duration_ms)} · {bytes(card.bytes)}
            </div>
            <Meter value={card.fill} />
            <div className="muted" style={{ fontSize: "var(--text-xs)", marginTop: 5 }}>
              {Math.round(card.fill * 100)}% full · limited by {card.bound_by === "time" ? "the 5-hour cap" : "500 MB"}
            </div>
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
  const [kbps, setKbps] = useState<number | null>(null);
  const [mono, setMono] = useState(true);
  const [strategy, setStrategy] = useState<"sequential" | "compact">("sequential");
  const [enforceHours, setEnforceHours] = useState(true);

  useEffect(() => {
    if (settings.data) setStrategy(settings.data.preferences.pack_strategy);
  }, [settings.data]);

  const body = {
    groups,
    strategy,
    kbps,
    mono,
    use_optimized: true,
    max_hours: enforceHours ? undefined : 0,
  };
  const preview = useQuery({
    queryKey: ["pack", JSON.stringify(body)],
    queryFn: () => api.post<PackPreview>("/pack/preview", body),
    enabled: groups.some((g) => g.track_ids.length > 0),
  });
  const create = useAction(
    () =>
      api.post<{ batch: string; playlists: Playlist[] }>("/yoto/playlists/from-pack", {
        ...body,
        cover_url: coverUrl ?? "",
        downsize_first: kbps !== null,
      }),
    [["playlists"]],
  );
  const cards = preview.data?.cards.length ?? 0;
  const trackCount = groups.reduce((a, g) => a + g.track_ids.length, 0);

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
            disabled={!cards}
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
          {trackCount} track{trackCount === 1 ? "" : "s"} from {groups.map((g) => g.title).join(", ")}. Each Yoto card holds up to 100
          tracks, 500 MB and 5 hours; tracks over an hour are split into parts.
        </p>

        <div className="stack">
          <strong>Audio size</strong>
          <BitratePicker kbps={kbps} mono={mono} onChange={(k, m) => (setKbps(k), setMono(m))} allowOriginal />
        </div>

        <div className="row wrap" style={{ "--gap": "18px" } as React.CSSProperties}>
          <div className="stack" style={{ "--gap": "6px" } as React.CSSProperties}>
            <strong>Packing</strong>
            <div className="segmented">
              <button className={strategy === "sequential" ? "active" : ""} onClick={() => setStrategy("sequential")}>
                <Layers size={13} /> Keep in order
              </button>
              <button className={strategy === "compact" ? "active" : ""} onClick={() => setStrategy("compact")}>
                Fewest cards
              </button>
            </div>
          </div>
          <label className="check" style={{ marginTop: 22 }}>
            <input type="checkbox" checked={enforceHours} onChange={(e) => setEnforceHours(e.target.checked)} />
            Respect the 5-hour card limit
          </label>
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
          <div className="stack" style={{ "--gap": "12px" } as React.CSSProperties}>
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
            <PackResult preview={preview.data} />
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
