import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Download, ExternalLink, FileText, MessageCircle, Minimize2, Pause, Play, RefreshCw, SquareStack, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import CardPlanner from "../components/CardPlanner";
import { AskPanel } from "../components/Ask";
import { TranscriptView } from "../components/Listen";
import { TrackStatus, queueFor } from "../components/TrackList";
import { BitratePicker, DownsizeDialog, TranscribeDialog } from "../components/Tools";
import { StarButton } from "../components/StarButton";
import { Button, Cover, Modal, Note, Spinner, errorText, useToast } from "../components/ui";
import { bytes, date, duration, relative, stripHtml } from "../format";
import { useAction, useActiveJob } from "../hooks/queries";
import { usePlayer } from "../player";
import type { Episode, Job, PodcastDetail as PodcastDetailT, Track } from "../types";
import { JobLine } from "./BookDetail";

export default function PodcastDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const player = usePlayer();
  const podcast = useQuery({ queryKey: ["podcast", id], queryFn: () => api.get<PodcastDetailT>(`/podcasts/${id}`) });
  const job = useActiveJob("podcast", Number(id));
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [filter, setFilter] = useState<"all" | "saved" | "remote">("all");
  const [order, setOrder] = useState<"newest" | "oldest">("oldest");
  const [dialog, setDialog] = useState<"download" | "downsize" | "transcribe" | "yoto" | null>(null);
  const [episodeView, setEpisodeView] = useState<{ episode: Episode; mode: "transcript" | "ask" } | null>(null);
  const refresh = useAction(() => api.post(`/podcasts/${id}/refresh`), [["podcast", id], ["podcasts"]]);
  const remove = useAction(() => api.del(`/podcasts/${id}`), [["podcasts"]]);

  const p = podcast.data;
  const episodes = useMemo(() => {
    const list = (p?.episodes ?? []).filter((e) => (filter === "saved" ? e.status === "ready" : filter === "remote" ? e.status !== "ready" : true));
    return order === "oldest" ? [...list].reverse() : list;
  }, [p, filter, order]);

  if (podcast.isLoading) return <Spinner size={26} />;
  if (podcast.isError || !p) return <Note tone="error">{errorText(podcast.error)}</Note>;

  const saved = p.episodes.filter((e) => e.track);
  const savedTracks = saved.map((e) => e.track!) as Track[];
  const chosen = selected.size ? p.episodes.filter((e) => selected.has(e.id)) : [];
  const chosenTracks = (chosen.length ? chosen : saved).filter((e) => e.track).map((e) => e.track!) as Track[];
  const chronological = [...(chosen.length ? chosen : saved)].filter((e) => e.track).sort((a, b) => (a.published_at ?? "").localeCompare(b.published_at ?? ""));
  const toggle = (eid: number) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(eid)) next.delete(eid);
      else next.add(eid);
      return next;
    });

  return (
    <>
      <Link to="/podcasts" className="breadcrumb">
        <ArrowLeft size={15} /> Podcasts
      </Link>
      <section className="hero podcast">
        <Cover src={p.image_url} title={p.title} />
        <div>
          <div className="eyebrow">Podcast</div>
          <h1>{p.title}</h1>
          <p className="byline">{p.author}</p>
          <div className="facts">
            <div><b>{p.episode_count}</b>Episodes</div>
            <div><b>{p.downloaded_count}</b>Saved</div>
            <div><b>{bytes(p.downloaded_bytes)}</b>{p.downsized_count ? "Originals" : "On server"}</div>
            {p.downsized_count > 0 && (
              <div title={p.downsized_count < p.downloaded_count ? "Episodes not yet downsized count at their original size" : undefined}>
                <b>{bytes(p.downsized_bytes)}</b>
                {p.downsized_count < p.downloaded_count ? `Downsized (${p.downsized_count} of ${p.downloaded_count})` : "Downsized"}
              </div>
            )}
            <div><b>{duration(p.total_duration_ms)}</b>Total listening</div>
            <div><b>{relative(p.last_refreshed_at)}</b>Checked</div>
          </div>
          <p className="summary">{stripHtml(p.description)}</p>
          <div className="row wrap" style={{ marginTop: 16 }}>
            <Button variant="primary" icon={<Download size={17} />} disabled={!!job} onClick={() => setDialog("download")}>
              {selected.size ? `Download ${selected.size} selected` : `Download all (${p.episode_count - p.downloaded_count})`}
            </Button>
            <Button icon={<SquareStack size={16} />} disabled={!saved.length} onClick={() => setDialog("yoto")}>
              Make Yoto cards
            </Button>
            <Button icon={<FileText size={16} />} disabled={!saved.length} onClick={() => setDialog("transcribe")}>Transcribe</Button>
            <Button icon={<Minimize2 size={16} />} disabled={!saved.length} onClick={() => setDialog("downsize")}>Downsize</Button>
            <Button variant="ghost" icon={<RefreshCw size={16} />} loading={refresh.isPending} onClick={() => refresh.mutate(undefined, { onSuccess: () => toast("Feed refreshed") })}>
              Refresh
            </Button>
            {p.apple_url && (
              <a className="btn ghost" href={p.apple_url} target="_blank" rel="noreferrer">
                <ExternalLink size={16} /> Apple
              </a>
            )}
            <StarButton kind="podcast" id={p.id} title={p.title} />
          </div>
          {job && <JobLine job={job} />}
        </div>
      </section>

      <div className="toolbar">
        <div className="segmented">
          {(["all", "saved", "remote"] as const).map((f) => (
            <button key={f} className={filter === f ? "active" : ""} onClick={() => setFilter(f)}>
              {f === "all" ? "All" : f === "saved" ? "Saved" : "Not downloaded"}
            </button>
          ))}
        </div>
        <div className="segmented">
          {(["newest", "oldest"] as const).map((o) => (
            <button key={o} className={order === o ? "active" : ""} onClick={() => setOrder(o)}>
              {o === "newest" ? "Newest first" : "Oldest first"}
            </button>
          ))}
        </div>
        <span className="spacer" />
        {selected.size > 0 && (
          <>
            <span className="muted" style={{ fontSize: "var(--text-sm)" }}>{selected.size} selected</span>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
          </>
        )}
        <Button size="sm" variant="ghost" onClick={() => setSelected(new Set(episodes.map((e) => e.id)))}>Select all shown</Button>
      </div>

      <div className="list">
        {episodes.map((e) => {
          const track = e.track;
          const isCurrent = !!track && player.current?.trackId === track.id;
          return (
            <div key={e.id} className={`list-row ${isCurrent ? "playing" : ""}`}>
              <div className="row" style={{ "--gap": "10px" } as React.CSSProperties}>
                <input type="checkbox" checked={selected.has(e.id)} onChange={() => toggle(e.id)} style={{ accentColor: "var(--terracotta)", width: 16, height: 16 }} aria-label={`Select ${e.title}`} />
                <button
                  className="play-dot"
                  disabled={!track}
                  title={track ? "Play" : "Download to play"}
                  onClick={() => {
                    if (!track) return;
                    if (isCurrent) return player.toggle();
                    const q = queueFor([track], { subtitle: p.title, cover: e.image_url || p.image_url, link: `/podcasts/${p.id}` });
                    player.play(q, 0);
                  }}
                >
                  {isCurrent && player.playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" style={{ marginLeft: 2 }} />}
                </button>
              </div>
              <div style={{ minWidth: 0 }}>
                <div className="title truncate">{e.title}</div>
                <div className="sub">
                  <span>{date(e.published_at)}</span>
                  {e.duration_ms > 0 && <span>{duration(e.duration_ms)}</span>}
                  {e.status === "downloading" && <span className="pill honey">Downloading…</span>}
                  {e.status === "failed" && <span className="pill berry">Download failed</span>}
                  {track && <TrackStatus track={track} />}
                </div>
              </div>
              <div className="actions">
                {track?.transcript_status === "ready" && (
                  <>
                    <Button size="sm" variant="ghost" iconOnly icon={<FileText size={15} />} title="Transcript" onClick={() => setEpisodeView({ episode: e, mode: "transcript" })} />
                    <Button size="sm" variant="ghost" iconOnly icon={<MessageCircle size={15} />} title="Ask about this episode" onClick={() => setEpisodeView({ episode: e, mode: "ask" })} />
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="row" style={{ marginTop: 24 }}>
        <span className="spacer" />
        <Button
          variant="danger"
          size="sm"
          icon={<Trash2 size={14} />}
          onClick={() => confirm(`Unfollow ${p.title} and delete its downloaded episodes?`) && remove.mutate(undefined, { onSuccess: () => navigate("/podcasts") })}
        >
          Unfollow & delete files
        </Button>
      </div>

      {dialog === "download" && <DownloadDialog podcastId={p.id} episodeIds={[...selected]} remaining={p.episode_count - p.downloaded_count} onClose={() => setDialog(null)} />}
      {dialog === "downsize" && <DownsizeDialog tracks={chosenTracks.length ? chosenTracks : savedTracks} onClose={() => setDialog(null)} />}
      {dialog === "transcribe" && <TranscribeDialog tracks={chosenTracks.length ? chosenTracks : savedTracks} onClose={() => setDialog(null)} />}
      {dialog === "yoto" && (
        <CardPlanner groups={[{ key: `podcast:${p.id}`, title: p.title, track_ids: chronological.map((e) => e.track!.id) }]} coverUrl={p.image_url} onClose={() => setDialog(null)} />
      )}
      {episodeView && episodeView.episode.track && (
        <Modal wide title={episodeView.episode.title} onClose={() => setEpisodeView(null)}>
          <EpisodeListen episode={episodeView.episode} mode={episodeView.mode} podcastTitle={p.title} cover={p.image_url} onClose={() => setEpisodeView(null)} />
        </Modal>
      )}
    </>
  );
}

function EpisodeListen({ episode, mode, podcastTitle, cover, onClose }: { episode: Episode; mode: "transcript" | "ask"; podcastTitle: string; cover: string; onClose: () => void }) {
  const player = usePlayer();
  const queue = queueFor([episode.track!], { subtitle: podcastTitle, cover: episode.image_url || cover });
  const position = player.current?.trackId === episode.track!.id ? player.positionMs : episode.track!.duration_ms;
  return mode === "transcript" ? (
    <TranscriptView work={{ episode_id: episode.id }} queue={queue} positionMs={position} />
  ) : (
    <AskPanel work={{ episode_id: episode.id }} queue={queue} totalMs={episode.track!.duration_ms} positionMs={position} title="this episode" onClose={onClose} />
  );
}

function DownloadDialog({ podcastId, episodeIds, remaining, onClose }: { podcastId: number; episodeIds: number[]; remaining: number; onClose: () => void }) {
  const toast = useToast();
  const [kbps, setKbps] = useState<number | null>(null);
  const [mono, setMono] = useState(true);
  const run = useAction(() => api.post<Job>(`/podcasts/${podcastId}/download`, { episode_ids: episodeIds, kbps, mono }), [["podcast"]]);
  const count = episodeIds.length || remaining;
  return (
    <Modal
      title={`Download ${count} episode${count === 1 ? "" : "s"}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            icon={<Download size={16} />}
            loading={run.isPending}
            onClick={() =>
              run.mutate(undefined, {
                onSuccess: () => (toast("Downloading in the background"), onClose()),
                onError: (e) => toast(errorText(e), "error"),
              })
            }
          >
            Download
          </Button>
        </>
      }
    >
      <div className="stack" style={{ "--gap": "14px" } as React.CSSProperties}>
        <p className="muted">Episodes download oldest first. Optionally make a smaller copy of each as it arrives.</p>
        <BitratePicker kbps={kbps} mono={mono} onChange={(k, m) => (setKbps(k), setMono(m))} allowOriginal />
      </div>
    </Modal>
  );
}
