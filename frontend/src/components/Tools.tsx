import { useQuery } from "@tanstack/react-query";
import { FileText, Minimize2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { bytes, duration } from "../format";
import { useAction } from "../hooks/queries";
import type { Job, Preset, Track } from "../types";
import ModelPicker, { type ModelChoice } from "./ModelPicker";
import { Button, Modal, Note, useToast, errorText } from "./ui";

export function usePresets() {
  return useQuery({
    queryKey: ["presets"],
    queryFn: () => api.get<{ default_kbps: number; default_mono: boolean; presets: Preset[] }>("/audio/presets"),
    staleTime: Infinity,
  });
}

export function BitratePicker({
  kbps,
  mono,
  onChange,
  allowOriginal,
}: {
  kbps: number | null;
  mono: boolean;
  onChange: (kbps: number | null, mono: boolean) => void;
  allowOriginal?: boolean;
}) {
  const presets = usePresets();
  return (
    <div className="stack">
      <div className="preset-grid">
        {allowOriginal && (
          <button type="button" className={`preset ${kbps === null ? "active" : ""}`} onClick={() => onChange(null, mono)}>
            <b>As is</b>
            <small>Use current files</small>
          </button>
        )}
        {(presets.data?.presets ?? []).map((p) => (
          <button key={p.kbps} type="button" className={`preset ${kbps === p.kbps ? "active" : ""}`} onClick={() => onChange(p.kbps, mono)}>
            <b>{p.kbps} kbps</b>
            <span style={{ fontWeight: 600, fontSize: "var(--text-sm)" }}>{p.label}</span>
            <small>{p.note}</small>
          </button>
        ))}
      </div>
      <label className="check">
        <input type="checkbox" checked={mono} onChange={(e) => onChange(kbps, e.target.checked)} />
        Mono — clearer speech at low bitrates; stories don't need stereo
      </label>
    </div>
  );
}

export function DownsizeDialog({ tracks, onClose }: { tracks: Track[]; onClose: () => void }) {
  const toast = useToast();
  const presets = usePresets();
  const [kbps, setKbps] = useState<number | null>(null);
  const [mono, setMono] = useState(true);
  useEffect(() => {
    if (kbps === null && presets.data) {
      setKbps(presets.data.default_kbps);
      setMono(presets.data.default_mono);
    }
  }, [presets.data, kbps]);
  const withFiles = tracks.filter((t) => t.has_file);
  const totalMs = withFiles.reduce((a, t) => a + t.duration_ms, 0);
  const current = withFiles.reduce((a, t) => a + t.size_bytes, 0);
  const estimate = kbps ? Math.round(((kbps * 1000) / 8) * (totalMs / 1000) * 1.01) : current;
  const run = useAction(() => api.post<Job>("/tracks/optimize", { track_ids: withFiles.map((t) => t.id), kbps, mono }), [["books"], ["podcast"], ["collection"]]);
  return (
    <Modal
      title="Downsize audio"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={<Minimize2 size={16} />}
            disabled={!withFiles.length || !kbps}
            loading={run.isPending}
            onClick={() =>
              run.mutate(undefined, {
                onSuccess: () => {
                  toast(`Downsizing ${withFiles.length} file(s) in the background`);
                  onClose();
                },
                onError: (e) => toast(errorText(e), "error"),
              })
            }
          >
            Downsize {withFiles.length} file{withFiles.length === 1 ? "" : "s"}
          </Button>
        </>
      }
    >
      <div className="stack" style={{ "--gap": "16px" } as React.CSSProperties}>
        <p className="muted">
          Re-encodes to a smaller MP3 alongside the original. Spoken word sounds clear well below music bitrates; 64 kbps mono is a
          good default, 48 kbps is still fine for audiobooks.
        </p>
        <BitratePicker kbps={kbps} mono={mono} onChange={(k, m) => (setKbps(k), setMono(m))} />
        <dl className="kv">
          <dt>Files</dt>
          <dd>
            {withFiles.length} · {duration(totalMs)}
          </dd>
          <dt>Now</dt>
          <dd>{bytes(current)}</dd>
          <dt>After</dt>
          <dd>
            about {bytes(estimate)} {current > estimate && <span className="pill sage">−{Math.round((1 - estimate / current) * 100)}%</span>}
          </dd>
        </dl>
        {withFiles.length < tracks.length && <Note>{tracks.length - withFiles.length} item(s) have no audio yet and will be skipped.</Note>}
      </div>
    </Modal>
  );
}

interface Estimate {
  tracks: number;
  minutes: number;
  provider: string;
  model: string;
  estimated_cost_usd: number | null;
  configured: boolean;
}

export function TranscribeDialog({ tracks, onClose }: { tracks: Track[]; onClose: () => void }) {
  const toast = useToast();
  const ids = tracks.filter((t) => t.has_file).map((t) => t.id);
  const [choice, setChoice] = useState<ModelChoice | null>(null);
  const body = { track_ids: ids, provider: choice?.provider, model: choice?.model };
  const estimate = useQuery({
    queryKey: ["transcribe-estimate", ids.join(","), choice?.provider, choice?.model],
    queryFn: () => api.post<Estimate>("/transcripts/estimate", body),
  });
  const run = useAction(() => api.post<Job>("/transcripts/transcribe", body), [["books"], ["podcast"], ["collection"]]);
  const e = estimate.data;
  return (
    <Modal
      title="Transcribe"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={<FileText size={16} />}
            disabled={!e?.tracks || !e.configured || !choice}
            loading={run.isPending}
            onClick={() =>
              run.mutate(undefined, {
                onSuccess: () => {
                  toast("Transcription started");
                  onClose();
                },
                onError: (err) => toast(errorText(err), "error"),
              })
            }
          >
            Transcribe {e?.tracks ?? ""} track{e?.tracks === 1 ? "" : "s"}
          </Button>
        </>
      }
    >
      <div className="stack" style={{ "--gap": "14px" } as React.CSSProperties}>
        <p className="muted">Speech-to-text with timestamps. Transcripts power search and “Ask about this book”.</p>
        {e && !e.configured ? (
          <Note>
            Add an OpenAI, Groq or Gemini API key in <Link to="/settings#ai">Settings</Link> first.
          </Note>
        ) : (
          <label className="field">
            <span>Model</span>
            <ModelPicker kind="stt" value={choice} onChange={setChoice} />
            <small>
              Groq Whisper is the cheapest. Models marked “timestamps every few seconds” line up most precisely; others
              are timed in 2-minute steps (Gemini's transcribe model times each word).
            </small>
          </label>
        )}
        {e && (
          <dl className="kv">
            <dt>Audio</dt>
            <dd>
              {e.tracks} track(s) · {duration(e.minutes * 60000)}
            </dd>
            <dt>Estimated cost</dt>
            <dd>{e.estimated_cost_usd === null ? "price not published for this model" : `$${e.estimated_cost_usd.toFixed(2)}`}</dd>
          </dl>
        )}
        {e && e.tracks === 0 && <Note tone="ok">Everything selected is already transcribed.</Note>}
      </div>
    </Modal>
  );
}
