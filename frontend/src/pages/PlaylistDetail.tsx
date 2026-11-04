import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowLeft, ArrowUp, CloudUpload, Save, SquareStack, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { queueFor } from "../components/TrackList";
import { Button, Meter, Modal, Note, Spinner, errorText, useToast } from "../components/ui";
import { bytes, clock, duration, relative } from "../format";
import { useAction, useActiveJob } from "../hooks/queries";
import { usePlayer } from "../player";
import type { Job, PlaylistDetail as PlaylistDetailT, SettingsData, YotoAccount } from "../types";
import { JobLine } from "./BookDetail";
import { statusPill } from "./Yoto";

export default function PlaylistDetail() {
  const { id } = useParams();
  const toast = useToast();
  const navigate = useNavigate();
  const player = usePlayer();
  const playlist = useQuery({ queryKey: ["playlist", id], queryFn: () => api.get<PlaylistDetailT>(`/yoto/playlists/${id}`) });
  const accounts = useQuery({ queryKey: ["yoto-accounts"], queryFn: () => api.get<YotoAccount[]>("/yoto/accounts") });
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api.get<SettingsData>("/settings") });
  const job = useActiveJob("playlist", Number(id));
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const save = useAction((body: object) => api.patch<PlaylistDetailT>(`/yoto/playlists/${id}`, body), [["playlist", id], ["playlists"]]);
  const sync = useAction(() => api.post<Job>("/yoto/sync", { playlist_ids: [Number(id)] }), [["playlist", id]]);
  const [deleting, setDeleting] = useState(false);

  const p = playlist.data;
  useEffect(() => {
    if (p) {
      setTitle(p.title);
      setDescription(p.description);
    }
  }, [p?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (playlist.isLoading) return <Spinner size={26} />;
  if (playlist.isError || !p) return <Note tone="error">{errorText(playlist.error)}</Note>;

  const ids = p.items.map((i) => i.id);
  const move = (index: number, delta: number) => {
    const next = [...ids];
    const [x] = next.splice(index, 1);
    next.splice(index + delta, 0, x);
    save.mutate({ item_ids: next });
  };
  const connected = (accounts.data ?? []).some((a) => a.connected);
  // The card limits come from Settings; a length limit of 0 means length isn't checked.
  const limitMb = settings.data?.preferences.card_limit_mb || 500;
  const limitHours = settings.data?.preferences.card_limit_hours ?? 0;
  const fillBytes = p.total_bytes / (limitMb * 1024 * 1024);
  const fillTime = limitHours > 0 ? p.total_duration_ms / (limitHours * 3600 * 1000) : 0;
  const dirty = title !== p.title || description !== p.description;

  return (
    <>
      <Link to="/yoto" className="breadcrumb">
        <ArrowLeft size={15} /> Yoto cards
      </Link>
      <section className="hero playlist">
        <div className="card-art" style={{ width: 160, fontSize: "2.4rem" }}>
          {p.cover_url ? <img src={p.cover_url} alt="" /> : <SquareStack size={40} />}
        </div>
        <div className="stack" style={{ "--gap": "14px" } as React.CSSProperties}>
          <div className="row">
            {statusPill(p.status)}
            {p.card_id && <span className="pill">Yoto ID {p.card_id}</span>}
            {p.last_synced_at && <span className="muted" style={{ fontSize: "var(--text-xs)" }}>synced {relative(p.last_synced_at)}</span>}
          </div>
          <input className="input serif" style={{ fontSize: "var(--text-2xl)", height: 54, fontWeight: 600 }} value={title} maxLength={140} onChange={(e) => setTitle(e.target.value)} aria-label="Title" />
          <textarea className="textarea" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description shown in the Yoto app (optional)" />
          <div className="grid-2" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <div>
              <div className="row muted" style={{ fontSize: "var(--text-xs)", marginBottom: 4 }}>
                Size <span className="spacer" /> {bytes(p.total_bytes)} / {limitMb} MB
              </div>
              <Meter value={fillBytes} />
            </div>
            <div>
              <div className="row muted" style={{ fontSize: "var(--text-xs)", marginBottom: 4 }}>
                Length <span className="spacer" /> {duration(p.total_duration_ms)}
                {limitHours > 0 && ` / ${limitHours} h`}
              </div>
              {limitHours > 0 && <Meter value={fillTime} />}
            </div>
          </div>
          {(fillBytes > 1 || fillTime > 1 || p.item_count > 100) && <Note tone="error">{fillTime > 1 && fillBytes <= 1 && p.item_count <= 100 ? `This is longer than the ${limitHours}-hour limit in Settings; remove some tracks, or set the limit to 0 if Yoto accepts it.` : "This is over a Yoto card's limits; remove some tracks or re-plan with a lower bitrate."}</Note>}
          {p.last_error && p.status === "failed" && <Note tone="error">{p.last_error}</Note>}
          <div className="row wrap">
            <Button
              variant="sage"
              icon={<CloudUpload size={16} />}
              disabled={!connected || !!job}
              loading={sync.isPending}
              onClick={() => sync.mutate(undefined, { onSuccess: () => toast("Syncing to Yoto"), onError: (e) => toast(errorText(e), "error") })}
            >
              {p.card_id ? "Update on Yoto" : "Send to Yoto"}
            </Button>
            {dirty && (
              <Button icon={<Save size={16} />} loading={save.isPending} onClick={() => save.mutate({ title, description })}>
                Save
              </Button>
            )}
            <label className="check" style={{ fontSize: "var(--text-sm)" }}>
              <input type="checkbox" checked={p.use_optimized} onChange={(e) => save.mutate({ use_optimized: e.target.checked })} />
              Use downsized files when available
            </label>
            <span className="spacer" />
            <Button variant="danger" size="sm" icon={<Trash2 size={14} />} disabled={!!job} onClick={() => setDeleting(true)}>
              Delete
            </Button>
          </div>
          {!connected && <Note tone="info">Connect a Yoto account on the Yoto page to send this card.</Note>}
          {p.card_id && <Note tone="info">Link it to a physical Make-Your-Own card from the Yoto app: Library → this playlist → Link to card.</Note>}
          {job && <JobLine job={job} />}
        </div>
      </section>
      {deleting && <DeletePlaylist playlist={p} onClose={() => setDeleting(false)} onDeleted={() => navigate("/yoto")} />}

      <div className="list">
        {p.items.map((item, i) => {
          const span = (item.end_ms ?? item.track.duration_ms) - (item.start_ms ?? 0);
          return (
            <div key={item.id} className="list-row">
              <span className="num">{i + 1}</span>
              <div style={{ minWidth: 0 }}>
                <div className="title truncate">{item.title || item.track.title}</div>
                <div className="sub">
                  <span>{duration(span)}</span>
                  {item.start_ms !== null && <span className="pill">from {clock(item.start_ms)}</span>}
                  {item.uploaded && <span className="pill sage">uploaded</span>}
                  {item.track.has_optimized && p.use_optimized && <span className="pill">{item.track.optimized_bitrate_kbps}k</span>}
                </div>
              </div>
              <div className="actions">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => player.play(queueFor([item.track], { subtitle: p.title, cover: p.cover_url }), 0, item.start_ms ?? 0)}
                >
                  Play
                </Button>
                <Button size="sm" variant="ghost" iconOnly icon={<ArrowUp size={14} />} disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up" />
                <Button size="sm" variant="ghost" iconOnly icon={<ArrowDown size={14} />} disabled={i === ids.length - 1} onClick={() => move(i, 1)} aria-label="Move down" />
                <Button size="sm" variant="danger" iconOnly icon={<Trash2 size={14} />} onClick={() => save.mutate({ item_ids: ids.filter((x) => x !== item.id) })} aria-label="Remove" />
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

type DeleteWhere = "yoto" | "everywhere" | "here";

const DELETE_CHOICES: { id: DeleteWhere; label: string; button: string; hint: string }[] = [
  { id: "yoto", label: "From Yoto only", button: "Delete from Yoto", hint: "Removes the card from your Yoto account. The playlist stays here as a draft, so you can send it again." },
  { id: "everywhere", label: "From Yoto and here", button: "Delete everywhere", hint: "Removes the card from your Yoto account and deletes the playlist here." },
  { id: "here", label: "Here only", button: "Delete here", hint: "Deletes the playlist here. The card stays on Yoto, but you can't update it from here any more." },
];

function DeletePlaylist({ playlist, onClose, onDeleted }: { playlist: PlaylistDetailT; onClose: () => void; onDeleted: () => void }) {
  const toast = useToast();
  const onYoto = !!playlist.card_id;
  const [where, setWhere] = useState<DeleteWhere>(onYoto ? "yoto" : "here");
  const remove = useAction(
    (w: DeleteWhere) =>
      w === "yoto" ? api.del(`/yoto/playlists/${playlist.id}/yoto`) : api.del(`/yoto/playlists/${playlist.id}?remote=${w === "everywhere"}`),
    [["playlists"], ["playlist", String(playlist.id)]],
  );
  const go = () =>
    remove.mutate(where, {
      onSuccess: () => {
        toast(where === "yoto" ? "Deleted from Yoto; the playlist is a draft again" : where === "everywhere" ? "Deleted from Yoto and here" : "Deleted");
        onClose();
        if (where !== "yoto") onDeleted();
      },
      onError: (e) => toast(errorText(e), "error"),
    });

  return (
    <Modal
      title={`Delete “${playlist.title}”`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" icon={<Trash2 size={16} />} loading={remove.isPending} onClick={go}>
            {onYoto ? DELETE_CHOICES.find((c) => c.id === where)!.button : "Delete"}
          </Button>
        </>
      }
    >
      {onYoto ? (
        <div className="choices" role="radiogroup">
          {DELETE_CHOICES.map((c) => (
            <label key={c.id}>
              <input type="radio" name="delete-where" checked={where === c.id} onChange={() => setWhere(c.id)} />
              <strong>{c.label}</strong>
              <small>{c.hint}</small>
            </label>
          ))}
        </div>
      ) : (
        <p className="muted">This playlist hasn't been sent to Yoto, so it's only deleted here.</p>
      )}
    </Modal>
  );
}
