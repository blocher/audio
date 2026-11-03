import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Download, FileText, ListMusic, MessageCircle, Minimize2, Play, RefreshCw, SquareStack, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api";
import CardPlanner from "../components/CardPlanner";
import { AskPanel, TranscriptView, useWorkPosition } from "../components/Listen";
import TrackList, { queueFor } from "../components/TrackList";
import { BitratePicker, DownsizeDialog, TranscribeDialog, usePresets } from "../components/Tools";
import { Button, Cover, Empty, Modal, Note, Progress, Spinner, Tabs, errorText, useToast } from "../components/ui";
import { clock, date, duration, relative, stripHtml } from "../format";
import { useAction, useActiveJob } from "../hooks/queries";
import { usePlayer } from "../player";
import type { BookDetail as BookDetailT, Job } from "../types";

type Tab = "chapters" | "transcript" | "ask";

export default function BookDetail() {
  const { id } = useParams();
  const toast = useToast();
  const player = usePlayer();
  const book = useQuery({ queryKey: ["books", id], queryFn: () => api.get<BookDetailT>(`/audible/books/${id}`) });
  const job = useActiveJob("book", Number(id));
  const [tab, setTab] = useState<Tab>("chapters");
  const [dialog, setDialog] = useState<"convert" | "downsize" | "transcribe" | "yoto" | null>(null);
  const [openSummary, setOpenSummary] = useState(false);
  const refreshPosition = useAction(() => api.post(`/audible/books/${id}/position`), [["books", id]]);
  const removeAudio = useAction(() => api.del(`/audible/books/${id}/audio`), [["books"]]);

  const b = book.data;
  const queue = b ? queueFor(b.tracks, { subtitle: b.title, cover: b.cover_url, link: `/books/${b.id}` }) : [];
  const position = useWorkPosition(queue, b?.position_ms ?? 0);

  if (book.isLoading) return <Spinner size={26} />;
  if (book.isError || !b) return <Note tone="error">{errorText(book.error)}</Note>;

  const totalMs = b.runtime_min * 60000;
  const ready = b.tracks.length > 0;
  const resumeIndex = Math.max(0, queue.findIndex((_, i) => (queue[i + 1]?.workOffsetMs ?? Infinity) > b.position_ms));

  return (
    <>
      <Link to="/" className="breadcrumb">
        <ArrowLeft size={15} /> Library
      </Link>
      <section className="hero">
        <Cover src={b.cover_url} title={b.title} />
        <div>
          {b.series && (
            <div className="eyebrow">
              {b.series}
              {b.series_position && ` · Book ${b.series_position}`}
            </div>
          )}
          <h1>{b.title}</h1>
          {b.subtitle && <p className="muted serif" style={{ fontSize: "var(--text-lg)" }}>{b.subtitle}</p>}
          <p className="byline">by {b.authors}</p>
          <div className="facts">
            <div>
              <b>{duration(totalMs)}</b>Length
            </div>
            {b.narrators && (
              <div>
                <b className="truncate" style={{ maxWidth: 220 }}>{b.narrators}</b>Narrated by
              </div>
            )}
            <div>
              <b>{b.account_name}</b>Audible account
            </div>
            {b.release_date && (
              <div>
                <b>{date(b.release_date)}</b>Released
              </div>
            )}
          </div>

          <div className="panel" style={{ padding: 16, marginBottom: 16, maxWidth: 620 }}>
            <div className="row" style={{ marginBottom: 10 }}>
              <strong>{b.is_finished ? "Finished" : b.position_ms ? `At ${clock(b.position_ms)} of ${clock(totalMs)}` : "Not started"}</strong>
              <span className="muted" style={{ fontSize: "var(--text-xs)" }}>
                from Audible · {relative(b.position_synced_at)}
              </span>
              <span className="spacer" />
              <Button size="sm" variant="ghost" icon={<RefreshCw size={14} />} loading={refreshPosition.isPending} onClick={() => refreshPosition.mutate()}>
                Refresh
              </Button>
            </div>
            <Progress value={b.is_finished ? 1 : b.position_ms / Math.max(totalMs, 1)} tone="terracotta" thick />
          </div>

          <div className="row wrap">
            {ready ? (
              <Button variant="primary" size="lg" icon={<Play size={18} fill="currentColor" />} onClick={() => player.play(queue, resumeIndex, b.position_ms - (queue[resumeIndex]?.workOffsetMs ?? 0))}>
                {b.position_ms ? "Resume" : "Play"}
              </Button>
            ) : (
              <Button variant="primary" size="lg" icon={<Download size={18} />} onClick={() => setDialog("convert")} disabled={!!job}>
                Convert to MP3
              </Button>
            )}
            {ready && (
              <>
                <Button icon={<SquareStack size={16} />} onClick={() => setDialog("yoto")}>
                  Make Yoto cards
                </Button>
                <Button icon={<FileText size={16} />} onClick={() => setDialog("transcribe")}>
                  Transcribe
                </Button>
                <Button icon={<Minimize2 size={16} />} onClick={() => setDialog("downsize")}>
                  Downsize
                </Button>
              </>
            )}
          </div>

          {job && <JobLine job={job} />}
          {b.status === "failed" && !job && <div style={{ marginTop: 14 }}><Note tone="error">The last conversion failed. Check Activity for details, then try again.</Note></div>}

          {b.summary && (
            <div style={{ marginTop: 18 }}>
              <p className={`summary ${openSummary ? "open" : ""}`}>{stripHtml(b.summary)}</p>
              <button className="btn ghost sm" style={{ marginTop: 4, paddingLeft: 0 }} onClick={() => setOpenSummary(!openSummary)}>
                {openSummary ? "Less" : "More"}
              </button>
            </div>
          )}
        </div>
      </section>

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "chapters", label: <><ListMusic size={16} /> Chapters {ready && <span className="pill">{b.tracks.length}</span>}</> },
          { id: "transcript", label: <><FileText size={16} /> Transcript {b.transcribed_count > 0 && <span className="pill sky">{b.transcribed_count}/{b.track_count}</span>}</> },
          { id: "ask", label: <><MessageCircle size={16} /> Ask about this book</> },
        ]}
      />

      {tab === "chapters" &&
        (ready ? (
          <>
            <TrackList tracks={b.tracks} meta={{ subtitle: b.title, cover: b.cover_url, link: `/books/${b.id}` }} />
            <div className="row" style={{ marginTop: 14 }}>
              <span className="muted" style={{ fontSize: "var(--text-sm)" }}>
                Converted at {b.convert_kbps} kbps {b.convert_mono ? "mono" : "stereo"}
              </span>
              <span className="spacer" />
              <Button size="sm" variant="ghost" onClick={() => setDialog("convert")}>Re-convert</Button>
              <Button
                size="sm"
                variant="danger"
                icon={<Trash2 size={14} />}
                onClick={() => confirm("Delete the downloaded audio and MP3s for this book?") && removeAudio.mutate()}
              >
                Delete audio
              </Button>
            </div>
          </>
        ) : (
          <Empty icon={<Download size={36} />} title="Not converted yet" action={<Button variant="primary" onClick={() => setDialog("convert")}>Convert to MP3</Button>}>
            Download this book from Audible, remove the DRM for your own listening, and split it into one MP3 per chapter.
          </Empty>
        ))}
      {tab === "transcript" && (ready ? <TranscriptView work={{ book_id: b.id }} queue={queue} positionMs={position} /> : <Empty title="Convert the book first" />)}
      {tab === "ask" &&
        (b.transcribed_count ? (
          <AskPanel work={{ book_id: b.id }} queue={queue} totalMs={totalMs} positionMs={position} title={b.title} />
        ) : (
          <Empty icon={<MessageCircle size={36} />} title="Transcribe to ask questions" action={ready ? <Button variant="primary" onClick={() => setDialog("transcribe")}>Transcribe</Button> : undefined}>
            Claude answers from the transcript up to where you are in the book — never past it.
          </Empty>
        ))}

      {dialog === "convert" && <ConvertDialog bookId={b.id} title={b.title} onClose={() => setDialog(null)} onStarted={() => toast("Converting in the background — this takes a few minutes")} />}
      {dialog === "downsize" && <DownsizeDialog tracks={b.tracks} onClose={() => setDialog(null)} />}
      {dialog === "transcribe" && <TranscribeDialog tracks={b.tracks} onClose={() => setDialog(null)} />}
      {dialog === "yoto" && (
        <CardPlanner groups={[{ key: `book:${b.id}`, title: b.title, track_ids: b.tracks.map((t) => t.id) }]} coverUrl={b.cover_url} onClose={() => setDialog(null)} />
      )}
    </>
  );
}

export function JobLine({ job }: { job: Job }) {
  return (
    <div className="panel" style={{ padding: 14, marginTop: 16, maxWidth: 620 }}>
      <div className="row" style={{ marginBottom: 8, fontSize: "var(--text-sm)" }}>
        <Spinner size={15} />
        <strong>{job.title}</strong>
        <span className="spacer" />
        <span className="tabular muted">{Math.round(job.progress * 100)}%</span>
      </div>
      <Progress value={job.progress} tone="terracotta" />
      {job.message && <div className="muted" style={{ fontSize: "var(--text-xs)", marginTop: 6 }}>{job.message}</div>}
    </div>
  );
}

function ConvertDialog({ bookId, title, onClose, onStarted }: { bookId: number; title: string; onClose: () => void; onStarted: () => void }) {
  const toast = useToast();
  const presets = usePresets();
  const [kbps, setKbps] = useState<number | null>(null);
  const [mono, setMono] = useState(true);
  const effective = kbps ?? presets.data?.default_kbps ?? 64;
  const run = useAction(() => api.post<Job>(`/audible/books/${bookId}/convert`, { kbps: effective, mono }), [["books"]]);
  return (
    <Modal
      title={`Convert “${title}”`}
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
                onSuccess: () => (onStarted(), onClose()),
                onError: (e) => toast(errorText(e), "error"),
              })
            }
          >
            Convert
          </Button>
        </>
      }
    >
      <div className="stack" style={{ "--gap": "16px" } as React.CSSProperties}>
        <p className="muted">Downloads the book from Audible, decrypts it with your account's key, and writes one MP3 per chapter.</p>
        <BitratePicker kbps={effective} mono={mono} onChange={(k, m) => (setKbps(k), setMono(m))} />
        <Note tone="info">For personal use with books you own. The original stays on the server so you can re-convert at another quality without downloading again.</Note>
      </div>
    </Modal>
  );
}
