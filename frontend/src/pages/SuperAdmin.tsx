import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Eye, Home, KeyRound, Mail, RefreshCw, Send, Trash2 } from "lucide-react";
import { useState } from "react";
import { Navigate } from "react-router-dom";
import { api } from "../api";
import { Button, Note, PageHead, Spinner, Tabs, errorText, useToast } from "../components/ui";
import { FEATURE_LABELS } from "../features";
import { bytes, relative } from "../format";
import { useAction } from "../hooks/queries";
import { useMe } from "../hooks/session";
import type { Feature, InviteSent } from "../types";

interface AskTotals {
  answers: number;
  tokens_in: number;
  tokens_out: number;
}

interface PersonRow {
  id: number;
  name: string;
  email: string;
  is_admin: boolean;
  last_login: string | null;
  joined: string;
  onboarded: boolean;
  features: Feature[];
}

interface LibraryRow {
  id: number;
  name: string;
  created_at: string;
  ai_keys: "own" | "shared" | "server" | "none";
  ai_keys_from: string | null;
  people: PersonRow[];
  usage: {
    audible_accounts: { name: string; connected: boolean }[];
    yoto_connected: number;
    books: number;
    books_converted: number;
    podcasts: number;
    folders: number;
    cards: number;
    cards_on_yoto: number;
    storage_bytes: number;
    transcribed_hours: number;
    transcribed_hours_30d: number;
    transcription_cost_estimate: number;
    ask: AskTotals;
    ask_30d: AskTotals;
    jobs_30d: number;
    jobs_failed_30d: number;
    last_job_at: string | null;
  };
}

interface InviteRow {
  id: number;
  email: string;
  name: string;
  invited_by: string;
  joining: string | null;
  created_at: string;
  expires_at: string;
  expired: boolean;
  emailed_at: string | null;
  accepted_at: string | null;
  link: string | null;
}

interface Overview {
  totals: {
    people: number;
    libraries: number;
    signed_in_30d: number;
    still_setting_up: number;
    invites_pending: number;
    invites_expired: number;
    invites_accepted: number;
    storage_bytes: number;
    transcription_cost_estimate: number;
  };
  households: LibraryRow[];
  invites: { pending: InviteRow[]; accepted: InviteRow[] };
}

const KEY_LABELS: Record<LibraryRow["ai_keys"], [string, string]> = {
  own: ["sage", "Own AI keys"],
  shared: ["honey", "Uses shared AI keys"],
  server: ["sky", "Server AI keys"],
  none: ["", "No AI keys"],
};

/** For super admins: everyone's libraries at a glance, the state of invitations, and "view as" for debugging. */
export default function SuperAdmin() {
  const me = useMe();
  const overview = useQuery({
    queryKey: ["superadmin"],
    queryFn: () => api.get<Overview>("/superadmin/overview"),
    enabled: !!me?.is_admin,
  });
  if (!me?.is_admin) return <Navigate to="/" replace />;
  const data = overview.data;
  return (
    <>
      <PageHead eyebrow="Super admin" title="Everyone's libraries" lede="Invitations, who's set up, and how much each library uses." />
      {overview.isError && <Note tone="error">{errorText(overview.error)}</Note>}
      {!data ? (
        <Spinner />
      ) : (
        <div className="stack" style={{ "--gap": "22px" } as React.CSSProperties}>
          <div className="admin-stats">
            <Stat label="People" value={data.totals.people} sub={`${data.totals.signed_in_30d} signed in this month`} />
            <Stat label="Libraries" value={data.totals.libraries} sub={data.totals.still_setting_up ? `${data.totals.still_setting_up} people still setting up` : "everyone's set up"} />
            <Stat
              label="Invitations"
              value={data.totals.invites_pending}
              sub={`waiting · ${data.totals.invites_accepted} accepted${data.totals.invites_expired ? ` · ${data.totals.invites_expired} expired` : ""}`}
            />
            <Stat label="Storage" value={bytes(data.totals.storage_bytes)} sub="audio on the server" />
            <Stat label="Transcription" value={`$${data.totals.transcription_cost_estimate.toFixed(2)}`} sub="estimated, all time" />
          </div>
          <InvitesPanel data={data} />
          {data.households.map((h) => (
            <LibraryPanel key={h.id} library={h} />
          ))}
        </div>
      )}
    </>
  );
}

function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub: string }) {
  return (
    <div className="admin-stat">
      <span className="admin-stat-label">{label}</span>
      <strong className="tabular">{value}</strong>
      <small>{sub}</small>
    </div>
  );
}

function InvitesPanel({ data }: { data: Overview }) {
  const toast = useToast();
  const [tab, setTab] = useState<"pending" | "accepted">(data.invites.pending.length ? "pending" : "accepted");
  const resend = useAction((id: number) => api.post<InviteSent>(`/users/invites/${id}/resend`), [["superadmin"], ["invites"]]);
  const cancel = useAction((id: number) => api.del(`/users/invites/${id}`), [["superadmin"], ["invites"]]);
  const rows = data.invites[tab];
  return (
    <section className="panel">
      <div className="panel-head">
        <Mail size={18} />
        <h3>Invitations</h3>
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "pending", label: `Waiting (${data.invites.pending.length})` },
            { id: "accepted", label: `Accepted (${data.invites.accepted.length})` },
          ]}
        />
      </div>
      {!rows.length ? (
        <p className="muted" style={{ margin: 0 }}>
          {tab === "pending" ? "No invitations waiting. Invite someone from Settings → People." : "Nobody has accepted an invitation yet."}
        </p>
      ) : (
        <div className="list">
          {rows.map((i) => (
            <div key={i.id} className="list-row">
              <span className="avatar" style={{ opacity: i.accepted_at ? 1 : 0.6 }}>{(i.name || i.email).slice(0, 1).toUpperCase()}</span>
              <div style={{ minWidth: 0 }}>
                <div className="title">
                  {i.name || i.email}{" "}
                  {i.accepted_at ? (
                    <span className="pill sage">Joined {relative(i.accepted_at)}</span>
                  ) : i.expired ? (
                    <span className="pill berry">Expired</span>
                  ) : (
                    <span className="pill honey">Waiting</span>
                  )}
                </div>
                <div className="sub">
                  {i.name && <span>{i.email}</span>}
                  <span>{i.joining ? `joins ${i.joining}` : "own library"}</span>
                  <span>invited by {i.invited_by || "—"} {relative(i.created_at)}</span>
                  {!i.accepted_at && <span>{i.emailed_at ? "emailed" : "link not emailed"}</span>}
                </div>
              </div>
              <div className="actions">
                  {i.link && (
                    <Button size="sm" variant="ghost" icon={<Copy size={14} />} onClick={() => void navigator.clipboard?.writeText(i.link!).then(() => toast("Link copied"))}>
                      Copy link
                    </Button>
                  )}
                  {!i.accepted_at && <Button
                    size="sm"
                    variant="ghost"
                    icon={i.expired ? <RefreshCw size={14} /> : <Send size={14} />}
                    onClick={() => resend.mutate(i.id, { onSuccess: (r) => toast(r.emailed ? `Sent again to ${i.email}` : "Link renewed for two more weeks") })}
                  >
                    {i.expired ? "Renew" : "Resend"}
                  </Button>}
                  <Button
                    size="sm"
                    variant="danger"
                    iconOnly
                    icon={<Trash2 size={14} />}
                    aria-label={`Delete ${i.email}'s invitation`}
                    title="Delete invitation"
                    onClick={() =>
                      confirm(
                        i.accepted_at
                          ? `Delete the record of ${i.email}'s invitation? Their login isn't affected.`
                          : `Delete the invitation to ${i.email}? The link stops working and it's gone for good.`,
                      ) && cancel.mutate(i.id)
                    }
                  />
                </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function LibraryPanel({ library: h }: { library: LibraryRow }) {
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const [viewing, setViewing] = useState<number | null>(null);
  const deleting = useAction(() => api.del(`/superadmin/households/${h.id}`), [["superadmin"], ["households"]]);
  const u = h.usage;
  const [tone, keys] = KEY_LABELS[h.ai_keys];

  async function viewAs(person: PersonRow) {
    setViewing(person.id);
    try {
      await api.post(`/superadmin/impersonate/${person.id}`);
      qc.clear();
      window.location.assign("/");
    } catch (e) {
      toast(errorText(e), "error");
      setViewing(null);
    }
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <Home size={18} />
        <h3>{h.name}</h3>
        {h.id === me?.household_id && <span className="pill sky">Yours</span>}
        <span className={`pill ${tone}`} title={h.ai_keys_from ? `From ${h.ai_keys_from}` : undefined}>
          <KeyRound size={11} /> {keys}
          {h.ai_keys === "shared" && h.ai_keys_from ? ` (${h.ai_keys_from})` : ""}
        </span>
      </div>
      <div className="list" style={{ marginBottom: 16 }}>
        {h.people.map((p) => (
          <div key={p.id} className="list-row">
            <span className="avatar">{p.name.slice(0, 1).toUpperCase()}</span>
            <div style={{ minWidth: 0 }}>
              <div className="title">
                {p.name} {p.is_admin && <span className="pill terracotta">Super admin</span>}{" "}
                {!p.onboarded && <span className="pill honey">Still setting up</span>}
              </div>
              <div className="sub">
                <span>{p.email}</span>
                <span>signed in {relative(p.last_login)}</span>
                <span>{p.features.length ? p.features.map((f) => FEATURE_LABELS[f]?.label ?? f).join(", ") : "everything"}</span>
              </div>
            </div>
            {p.id !== me?.id && (
              <Button size="sm" variant="ghost" icon={<Eye size={14} />} loading={viewing === p.id} onClick={() => void viewAs(p)} title={`See Audio exactly as ${p.name} does`}>
                View as
              </Button>
            )}
          </div>
        ))}
        {!h.people.length && (
          <div className="list-row">
            <span className="muted" style={{ flex: 1 }}>Nobody uses this library any more.</span>
            <Button
              size="sm"
              variant="danger"
              icon={<Trash2 size={14} />}
              loading={deleting.isPending}
              onClick={() =>
                confirm(`Delete ${h.name} and everything in it (Audible accounts, books and their audio, podcasts, folders, cards, keys)? This can't be undone.`) &&
                deleting.mutate(undefined, { onSuccess: () => toast(`Deleted ${h.name}`), onError: (e) => toast(errorText(e), "error") })
              }
            >
              Delete this library
            </Button>
          </div>
        )}
      </div>
      <dl className="kv admin-usage">
        <dt>Audible</dt>
        <dd>
          {u.audible_accounts.length
            ? u.audible_accounts.map((a) => `${a.name}${a.connected ? "" : " (not signed in)"}`).join(", ")
            : "none"}
        </dd>
        <dt>Books</dt>
        <dd>{u.books} · {u.books_converted} downloaded</dd>
        <dt>Podcasts & folders</dt>
        <dd>{u.podcasts} podcasts · {u.folders} folders</dd>
        <dt>Yoto</dt>
        <dd>{u.yoto_connected ? "connected" : "not connected"} · {u.cards} cards ({u.cards_on_yoto} on Yoto)</dd>
        <dt>Storage</dt>
        <dd>{bytes(u.storage_bytes)}</dd>
        <dt>Transcribed</dt>
        <dd>
          {u.transcribed_hours} h ({u.transcribed_hours_30d} h this month) · about ${u.transcription_cost_estimate.toFixed(2)}
        </dd>
        <dt>Ask</dt>
        <dd>
          {u.ask.answers} answers ({u.ask_30d.answers} this month) · {(u.ask.tokens_in + u.ask.tokens_out).toLocaleString()} tokens
        </dd>
        <dt>Background jobs</dt>
        <dd>
          {u.jobs_30d} this month
          {u.jobs_failed_30d > 0 && <span style={{ color: "var(--berry)" }}> · {u.jobs_failed_30d} failed</span>}
          {u.last_job_at && ` · last ${relative(u.last_job_at)}`}
        </dd>
      </dl>
    </section>
  );
}
