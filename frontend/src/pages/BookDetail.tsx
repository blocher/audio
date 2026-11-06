import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Download, FileText, ListMusic, MessageCircle, Minimize2, Play, RefreshCw, SquareStack, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { RESTORE, listHref } from "../hooks/listMemory";
import CardPlanner from "../components/CardPlanner";
import { AskPanel } from "../components/Ask";
import { MakeAskableButton, askState } from "../components/Askable";
import { TranscriptView, useWorkPosition } from "../components/Listen";
import TrackList, { queueFor } from "../components/TrackList";
import { BitratePicker, DownsizeDialog, TranscribeDialog, usePresets } from "../components/Tools";
import { StarButton } from "../components/StarButton";
import { Button, Cover, Empty, Modal, Note, Progress, Spinner, Tabs, errorText, useToast } from "../components/ui";
import { bytes, clock, date, duration, relative, stripHtml } from "../format";
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
  // The tab lives in the URL so the library can link straight to Ask (?tab=ask) and back closes it on a phone.
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const tab: Tab = (["chapters", "transcript", "ask"] as const).find((t) => t === params.get("tab")) ?? "chapters";
  const setTab = (next: Tab) => {
    if (next === tab) return;
    const p = new URLSearchParams(params);
    if (next === "chapters") p.delete("tab");
    else p.set("tab", next);
    p.delete("ask");
    setParams(p, { replace: next !== "ask", state: next === "ask" ? { askTab: true } : undefined });
  };
  // From the hero: on a phone Ask opens full screen; on a desktop, bring the tab into view.
  const openAsk = () => {
    setTab("ask");
    requestAnimationFrame(() => document.querySelector(".tabs")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };
  const closeAsk = () => {
    if ((location.state as { askTab?: boolean } | null)?.askTab) navigate(-1);
    else setTab("chapters");
  };
  const [dialog, setDialog] = useState<"convert" | "downsize" | "transcribe" | "yoto" | null>(null);
  const [openSummary, setOpenSummary] = useState(false);
  const refreshPosition = useAction(() => api.post(`/audible/books/${id}/position`), [["books", id]]);
  const removeAudio = useAction(() => api.del(`/audible/books/${id}/audio`), [["books"]]);

  const b = book.data;
  const queue = b ? queueFor(b.tracks, { subtitle: b.title, cover: b.cover_url, link: `/books/${b.id}` }) : [];
  const inPlayer = useWorkPosition(queue, -1); // -1: this book isn't in the player
  const position = inPlayer >= 0 ? inPlayer : (b?.position_ms ?? 0);

  // Ask's spoiler limit is the Audible position, so fetch a fresh one each time the Ask tab opens.
  const refreshedFor = useRef<string | null>(null);
  useEffect(() => {
    if (tab !== "ask") {
      refreshedFor.current = null; // leaving the tab: opening it again checks again
      return;
    }
    if (!b || refreshedFor.current === id) return;
    refreshedFor.current = id ?? null;
    refreshPosition.mutate(undefined, { onError: () => {} });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, b?.id]);

  if (book.isLoading) return <Spinner size={26} />;
  if (book.isError || !b) return <Note tone="error">{errorText(book.error)}</Note>;

  const totalMs = b.runtime_min * 60000;
  const ready = b.tracks.length > 0;
  const withFiles = b.tracks.filter((t) => t.has_file);
  const originalBytes = withFiles.reduce((a, t) => a + t.size_bytes, 0);
  const downsizedCount = withFiles.filter((t) => t.has_optimized).length;
  const currentBytes = withFiles.reduce((a, t) => a + (t.has_optimized ? t.optimized_size_bytes : t.size_bytes), 0);
  // Ask's spoiler limit is where you are in Audible; playing in this app doesn't move it.
  const askPosition = b.is_finished ? totalMs : b.position_ms;
  const askFarthest = b.is_finished ? totalMs : Math.max(b.farthest_ms ?? 0, b.position_ms);
  // Your own account's position; when the book isn't in your library, whoever's it is.
  const whose = b.position_is_mine || !b.position_account ? "your" : `${b.position_account}'s`;
  const askSource = refreshPosition.isPending
    ? "checking Audible…"
    : refreshPosition.isError
      ? `couldn't check Audible (${errorText(refreshPosition.error)}); last known position from ${relative(b.position_synced_at)}`
      : b.is_finished
        ? `finished on ${whose} Audible`
        : `${whose} Audible position, checked ${relative(b.position_synced_at)}`;
  const resumeIndex = Math.max(0, queue.findIndex((_, i) => (queue[i + 1]?.workOffsetMs ?? Infinity) > b.position_ms));

  return (
    <>
      <Link to={listHref("/library")} state={RESTORE} className="breadcrumb">
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
            {originalBytes > 0 && (
              <div title={downsizedCount ? `${bytes(originalBytes)} before downsizing` : undefined}>
                <b>{bytes(currentBytes)}</b>
                {downsizedCount === 0
                  ? "MP3 size"
                  : downsizedCount === withFiles.length
                    ? `Downsized from ${bytes(originalBytes)}`
                    : `${downsizedCount} of ${withFiles.length} downsized`}
              </div>
            )}
            <div>
              <b className="truncate" style={{ maxWidth: 220 }}>{b.account_names.join(" & ")}</b>
              {b.account_names.length > 1 ? "Audible libraries" : "Audible account"}
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
                from {b.position_is_mine || !b.position_account ? "your" : `${b.position_account}'s`} Audible · {relative(b.position_synced_at)}
              </span>
              <span className="spacer" />
              <Button size="sm" variant="ghost" icon={<RefreshCw size={14} />} loading={refreshPosition.isPending} onClick={() => refreshPosition.mutate()}>
                Refresh
              </Button>
            </div>
            <Progress value={b.is_finished ? 1 : b.position_ms / Math.max(totalMs, 1)} tone="terracotta" thick />
          </div>

          <div className="row wrap hero-actions">
            {!ready && <MakeAskableButton book={b} variant="primary" onAsk={openAsk} />}
            {ready ? (
              <Button variant="primary" size="lg" icon={<Play size={18} fill="currentColor" />} onClick={() => player.play(queue, resumeIndex, b.position_ms - (queue[resumeIndex]?.workOffsetMs ?? 0))}>
                {b.position_ms ? "Resume" : "Play"}
              </Button>
            ) : (
              <Button size="lg" icon={<Download size={18} />} onClick={() => setDialog("convert")} disabled={!!job}>
                Convert to MP3
              </Button>
            )}
            {ready && <MakeAskableButton book={b} onAsk={openAsk} />}
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
            <StarButton kind="book" id={b.id} title={b.title} />
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
          { id: "ask", label: <><MessageCircle size={16} /> Ask<span className="wide-only"> about this book</span></> },
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
          <AskPanel
            work={{ book_id: b.id }}
            queue={queue}
            totalMs={totalMs}
            positionMs={askPosition}
            positionNote={askSource}
            farthestMs={askFarthest}
            title={b.title}
            onClose={closeAsk}
          />
        ) : (
          <Empty
            icon={<MessageCircle size={36} />}
            title={job ? "Getting it ready to ask" : "Make this book askable"}
            action={<MakeAskableButton book={b} variant="primary" onAsk={openAsk} />}
          >
            {askState(b) === "none" && !ready
              ? "One tap downloads it at your default quality and transcribes it with your default model. Then ask anything — answers only use what you've heard so far."
              : "One tap transcribes it with your default model. Then ask anything — answers only use what you've heard so far."}
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
  const [mono, setMono] = useState<boolean | null>(null);
  // Until the presets load, send nothing and let the server use the saved default.
  const effective = kbps ?? presets.data?.default_kbps ?? null;
  const effectiveMono = mono ?? presets.data?.default_mono ?? true;
  const run = useAction(() => api.post<Job>(`/audible/books/${bookId}/convert`, { kbps: effective, mono: mono ?? presets.data?.default_mono }), [["books"]]);
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
        <BitratePicker kbps={effective} mono={effectiveMono} onChange={(k, m) => (setKbps(k), setMono(m))} />
        <Note tone="info">For personal use with books you own. The original stays on the server so you can re-convert at another quality without downloading again.</Note>
      </div>
    </Modal>
  );
}
