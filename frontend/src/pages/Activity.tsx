import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Clock, Loader2, X, XCircle } from "lucide-react";
import { useState } from "react";
import { api } from "../api";
import { Button, Empty, PageHead, Progress, Spinner } from "../components/ui";
import { relative } from "../format";
import { useJobs } from "../hooks/queries";
import type { Job } from "../types";

const ICONS: Record<Job["status"], React.ReactNode> = {
  queued: <Clock size={16} />,
  running: <Loader2 size={16} className="spin" />,
  succeeded: <CheckCircle2 size={16} />,
  failed: <AlertTriangle size={16} />,
  cancelled: <XCircle size={16} />,
};

export default function Activity() {
  const qc = useQueryClient();
  const jobs = useJobs();
  const [open, setOpen] = useState<number | null>(null);
  const list = jobs.data ?? [];
  const active = list.filter((j) => j.status === "running" || j.status === "queued");
  const done = list.filter((j) => !active.includes(j));

  async function cancel(id: number) {
    await api.post(`/jobs/${id}/cancel`);
    qc.invalidateQueries({ queryKey: ["jobs"] });
  }
  async function clear() {
    await api.del("/jobs/finished");
    qc.invalidateQueries({ queryKey: ["jobs"] });
  }

  const row = (j: Job) => (
    <div key={j.id} className={`job ${j.status}`}>
      <div className="icon">{ICONS[j.status]}</div>
      <div style={{ minWidth: 0 }}>
        <div className="title truncate">{j.title}</div>
        <div className="msg truncate">
          {j.message || j.status} · {relative(j.finished_at || j.started_at || j.created_at)}
        </div>
        {(j.status === "running" || j.status === "queued") && (
          <div style={{ marginTop: 6 }}>
            <Progress value={j.progress} tone="terracotta" />
          </div>
        )}
        {j.status === "failed" && j.error && (
          <>
            <button className="btn ghost sm" style={{ paddingLeft: 0 }} onClick={() => setOpen(open === j.id ? null : j.id)}>
              {open === j.id ? "Hide details" : "Show details"}
            </button>
            {open === j.id && (
              <pre style={{ whiteSpace: "pre-wrap", fontSize: "var(--text-xs)", background: "var(--paper-sunk)", padding: 12, borderRadius: 8, maxHeight: 280, overflow: "auto" }}>
                {j.error}
              </pre>
            )}
          </>
        )}
      </div>
      <div className="row">
        {(j.status === "running" || j.status === "queued") && (
          <>
            <span className="tabular muted" style={{ fontSize: "var(--text-sm)" }}>{Math.round(j.progress * 100)}%</span>
            <Button size="sm" variant="ghost" iconOnly icon={<X size={14} />} onClick={() => cancel(j.id)} aria-label="Cancel" />
          </>
        )}
      </div>
    </div>
  );

  return (
    <>
      <PageHead eyebrow="Activity" title="What's happening" lede="Downloads, conversions, transcriptions and Yoto uploads run in the background." />
      {jobs.isLoading ? (
        <Spinner />
      ) : !list.length ? (
        <Empty icon={<CheckCircle2 size={36} />} title="All quiet">Background work shows up here while it runs.</Empty>
      ) : (
        <div className="grid-2" style={{ alignItems: "start" }}>
          <section className="panel">
            <h3>Running {active.length > 0 && <span className="pill terracotta">{active.length}</span>}</h3>
            {active.length ? active.map(row) : <p className="muted">Nothing running.</p>}
          </section>
          <section className="panel">
            <div className="panel-head">
              <h3>Recent</h3>
              {done.length > 0 && <Button size="sm" variant="ghost" onClick={clear}>Clear</Button>}
            </div>
            {done.length ? done.map(row) : <p className="muted">Nothing yet.</p>}
          </section>
        </div>
      )}
    </>
  );
}
