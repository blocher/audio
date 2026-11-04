import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowLeft, ArrowUp, FileText, ListMusic, MessageCircle, Minimize2, Plus, SquareStack, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import CardPlanner from "../components/CardPlanner";
import { AskPanel, TranscriptView, useWorkPosition } from "../components/Listen";
import TrackList, { queueFor } from "../components/TrackList";
import { StarButton } from "../components/StarButton";
import { DownsizeDialog, TranscribeDialog } from "../components/Tools";
import { Button, Empty, Note, PageHead, Spinner, Tabs, errorText } from "../components/ui";
import { bytes, duration } from "../format";
import { useAction, useActiveJob } from "../hooks/queries";
import type { CollectionDetail } from "../types";
import { JobLine } from "./BookDetail";
import { ImportDialog } from "./Folders";

type Tab = "files" | "transcript" | "ask";

export default function FolderDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const folder = useQuery({ queryKey: ["collection", id], queryFn: () => api.get<CollectionDetail>(`/local/collections/${id}`) });
  const job = useActiveJob("collection", Number(id));
  const [tab, setTab] = useState<Tab>("files");
  const [dialog, setDialog] = useState<"add" | "downsize" | "transcribe" | "yoto" | null>(null);
  const [editing, setEditing] = useState(false);
  const remove = useAction(() => api.del(`/local/collections/${id}`), [["collections"]]);
  const reorder = useAction((ids: number[]) => api.post(`/local/collections/${id}/reorder`, { track_ids: ids }), [["collection", id]]);
  const removeTrack = useAction((tid: number) => api.del(`/local/tracks/${tid}`), [["collection", id]]);

  const c = folder.data;
  const queue = c ? queueFor(c.tracks, { subtitle: c.name, link: `/folders/${c.id}` }) : [];
  const position = useWorkPosition(queue, c?.total_duration_ms ?? 0);
  if (folder.isLoading) return <Spinner size={26} />;
  if (folder.isError || !c) return <Note tone="error">{errorText(folder.error)}</Note>;

  const ids = c.tracks.map((t) => t.id);
  const move = (index: number, delta: number) => {
    const next = [...ids];
    const [item] = next.splice(index, 1);
    next.splice(index + delta, 0, item);
    reorder.mutate(next);
  };
  const transcribed = c.tracks.filter((t) => t.transcript_status === "ready").length;

  return (
    <>
      <Link to="/folders" className="breadcrumb">
        <ArrowLeft size={15} /> Local folders
      </Link>
      <PageHead
        eyebrow="Local folder"
        title={c.name}
        lede={`${c.track_count} files · ${duration(c.total_duration_ms)} · ${bytes(c.total_bytes)}`}
        actions={
          <>
            <Button variant="primary" icon={<SquareStack size={16} />} disabled={!c.tracks.length} onClick={() => setDialog("yoto")}>
              Make Yoto cards
            </Button>
            <Button icon={<Minimize2 size={16} />} disabled={!c.tracks.length} onClick={() => setDialog("downsize")}>Downsize</Button>
            <Button icon={<FileText size={16} />} disabled={!c.tracks.length} onClick={() => setDialog("transcribe")}>Transcribe</Button>
            <Button icon={<Plus size={16} />} onClick={() => setDialog("add")}>Add files</Button>
            <StarButton kind="folder" id={c.id} title={c.name} />
          </>
        }
      />
      {job && <JobLine job={job} />}

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "files", label: <><ListMusic size={16} /> Files</> },
          { id: "transcript", label: <><FileText size={16} /> Transcript</> },
          { id: "ask", label: <><MessageCircle size={16} /> Ask</> },
        ]}
      />
      {tab === "files" &&
        (c.tracks.length ? (
          <>
            <div className="row" style={{ marginBottom: 10 }}>
              <span className="spacer" />
              <Button size="sm" variant="ghost" onClick={() => setEditing(!editing)}>{editing ? "Done" : "Reorder & remove"}</Button>
            </div>
            {editing ? (
              <div className="list">
                {c.tracks.map((t, i) => (
                  <div key={t.id} className="list-row">
                    <span className="num">{i + 1}</span>
                    <div className="title truncate">{t.title}</div>
                    <div className="actions">
                      <Button size="sm" variant="ghost" iconOnly icon={<ArrowUp size={14} />} disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up" />
                      <Button size="sm" variant="ghost" iconOnly icon={<ArrowDown size={14} />} disabled={i === c.tracks.length - 1} onClick={() => move(i, 1)} aria-label="Move down" />
                      <Button size="sm" variant="danger" iconOnly icon={<Trash2 size={14} />} onClick={() => removeTrack.mutate(t.id)} aria-label="Remove" />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <TrackList tracks={c.tracks} meta={{ subtitle: c.name, link: `/folders/${c.id}` }} />
            )}
          </>
        ) : (
          <Empty title="This folder is empty" action={<Button variant="primary" onClick={() => setDialog("add")}>Add files</Button>} />
        ))}
      {tab === "transcript" && <TranscriptView work={{ collection_id: c.id }} queue={queue} positionMs={position} />}
      {tab === "ask" &&
        (transcribed ? (
          <AskPanel work={{ collection_id: c.id }} queue={queue} totalMs={c.total_duration_ms} positionMs={position} title={c.name} />
        ) : (
          <Empty icon={<MessageCircle size={36} />} title="Transcribe to ask questions" />
        ))}

      <div className="row" style={{ marginTop: 28 }}>
        <span className="spacer" />
        <Button
          size="sm"
          variant="danger"
          icon={<Trash2 size={14} />}
          onClick={() => confirm(`Delete “${c.name}” and its files from the server?`) && remove.mutate(undefined, { onSuccess: () => navigate("/folders") })}
        >
          Delete folder
        </Button>
      </div>

      {dialog === "add" && <ImportDialog collection={c} onClose={() => setDialog(null)} />}
      {dialog === "downsize" && <DownsizeDialog tracks={c.tracks} onClose={() => setDialog(null)} />}
      {dialog === "transcribe" && <TranscribeDialog tracks={c.tracks} onClose={() => setDialog(null)} />}
      {dialog === "yoto" && <CardPlanner groups={[{ key: `folder:${c.id}`, title: c.name, track_ids: ids }]} onClose={() => setDialog(null)} />}
    </>
  );
}
