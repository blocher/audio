import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Pencil, Trash2, UserPlus, Users } from "lucide-react";
import { useState } from "react";
import { api } from "../api";
import { relative } from "../format";
import { useAction } from "../hooks/queries";
import type { AudibleAccount, Person } from "../types";
import { Button, Modal, Note, errorText, useToast } from "./ui";

/** Who can sign in. Admins see and manage everyone; anyone else sees just themselves. */
export function PeopleSection() {
  const toast = useToast();
  const people = useQuery({ queryKey: ["people"], queryFn: () => api.get<Person[]>("/users") });
  const accounts = useQuery({ queryKey: ["audible-accounts"], queryFn: () => api.get<AudibleAccount[]>("/audible/accounts") });
  const me = people.data?.find((p) => p.is_me);
  const isAdmin = !!me?.is_admin;
  const [editing, setEditing] = useState<Person | "new" | null>(null);
  const [password, setPassword] = useState<Person | null>(null);
  // Picking someone's account changes which positions they see, and "Yours" on the accounts list.
  const refresh: string[][] = [["people"], ["audible-accounts"], ["books"], ["session"]];
  const pickAccount = useAction(
    ({ id, account }: { id: number; account: number | null }) => api.patch(`/users/${id}`, { audible_account_id: account }),
    refresh,
  );
  const remove = useAction((id: number) => api.del(`/users/${id}`), [["people"]]);

  return (
    <section className="panel" id="people">
      <div className="panel-head">
        <Users size={18} />
        <h3>{isAdmin ? "People" : "Your sign-in"}</h3>
        {isAdmin && (
          <Button size="sm" icon={<UserPlus size={15} />} onClick={() => setEditing("new")}>Add person</Button>
        )}
      </div>
      <p className="muted" style={{ marginBottom: 14 }}>
        {isAdmin
          ? "Everyone who can sign in. Each person's Audible account decides which listening position they see, including in Ask."
          : "Your name, email and password, and which Audible account is yours."}
      </p>
      {people.isError && <Note tone="error">{errorText(people.error)}</Note>}
      <div className="list">
        {(people.data ?? []).map((p) => (
          <div key={p.id} className="list-row person-row">
            <span className="avatar">{(p.first_name || p.username).slice(0, 1).toUpperCase()}</span>
            <div style={{ minWidth: 0 }}>
              <div className="title">
                {p.first_name || p.username} {p.is_me && <span className="pill sky">You</span>}{" "}
                {p.is_admin && <span className="pill terracotta">Admin</span>}
              </div>
              <div className="sub">
                <span>{p.username}</span>
                {p.email && <span>{p.email}</span>}
                <span>signed in {relative(p.last_login)}</span>
              </div>
            </div>
            <div className="person-audible">
              <label className="muted" style={{ fontSize: "var(--text-sm)" }} htmlFor={`audible-${p.id}`} title={`Whose Audible position ${p.first_name || p.username} sees`}>
                Audible
              </label>
              <select
                id={`audible-${p.id}`}
                className="select"
                style={{ width: "auto" }}
                value={p.audible_account_id ?? ""}
                onChange={(e) =>
                  pickAccount.mutate(
                    { id: p.id, account: e.target.value ? Number(e.target.value) : null },
                    { onSuccess: () => toast(`Saved ${p.first_name || p.username}'s Audible account`) },
                  )
                }
              >
                <option value="">First connected</option>
                {(accounts.data ?? []).map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </div>
            <div className="actions">
              <Button size="sm" iconOnly icon={<Pencil size={14} />} aria-label={`Edit ${p.username}`} onClick={() => setEditing(p)} />
              <Button size="sm" iconOnly icon={<KeyRound size={14} />} aria-label={`Change ${p.username}'s password`} onClick={() => setPassword(p)} />
              {isAdmin && !p.is_me && (
                <Button
                  size="sm"
                  variant="danger"
                  iconOnly
                  icon={<Trash2 size={14} />}
                  aria-label={`Remove ${p.username}`}
                  onClick={() =>
                    confirm(`Remove ${p.first_name || p.username}? They can't sign in any more; their stars go too.`) &&
                    remove.mutate(p.id, { onSuccess: () => toast(`Removed ${p.first_name || p.username}`) })
                  }
                />
              )}
            </div>
          </div>
        ))}
      </div>
      {editing && <PersonDialog person={editing === "new" ? null : editing} isAdmin={isAdmin} accounts={accounts.data ?? []} onClose={() => setEditing(null)} />}
      {password && <PasswordDialog person={password} onClose={() => setPassword(null)} />}
    </section>
  );
}

function PersonDialog({ person, isAdmin, accounts, onClose }: { person: Person | null; isAdmin: boolean; accounts: AudibleAccount[]; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [username, setUsername] = useState(person?.username ?? "");
  const [firstName, setFirstName] = useState(person?.first_name ?? "");
  const [email, setEmail] = useState(person?.email ?? "");
  const [admin, setAdmin] = useState(person?.is_admin ?? false);
  const [password, setPassword] = useState("");
  const [account, setAccount] = useState<number | null>(person?.audible_account_id ?? null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError("");
    const body = { username, first_name: firstName, email, ...(isAdmin ? { is_admin: admin } : {}) };
    try {
      if (person) await api.patch(`/users/${person.id}`, body);
      else await api.post("/users", { ...body, password, audible_account_id: account });
      for (const key of ["people", "session", "audible-accounts", "books"]) qc.invalidateQueries({ queryKey: [key] });
      toast(person ? "Saved" : `Added ${firstName || username}`);
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={person ? `Edit ${person.first_name || person.username}` : "Add a person"}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!username.trim() || (!person && !password)} onClick={save}>
            {person ? "Save" : "Add person"}
          </Button>
        </>
      }
    >
      <div className="stack" style={{ "--gap": "14px" } as React.CSSProperties}>
        <div className="grid-2">
          <label className="field">
            <span>Name</span>
            <input className="input" value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="Sam" autoFocus />
          </label>
          <label className="field">
            <span>Username</span>
            <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoCapitalize="none" autoComplete="off" />
            <small>What they type to sign in.</small>
          </label>
        </div>
        <label className="field">
          <span>Email</span>
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Optional" />
        </label>
        {!person && (
          <>
            <label className="field">
              <span>Password</span>
              <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
              <small>At least 8 characters, not too common. Tell them, and they can change it later.</small>
            </label>
            <label className="field">
              <span>Their Audible account</span>
              <select className="select" value={account ?? ""} onChange={(e) => setAccount(e.target.value ? Number(e.target.value) : null)}>
                <option value="">First connected account</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
              <small>Whose listening position they see, and Ask stops at.</small>
            </label>
          </>
        )}
        {isAdmin && (
          <label className="check">
            <input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} />
            Admin: can add and remove people and change their passwords
          </label>
        )}
        {error && <Note tone="error">{error}</Note>}
      </div>
    </Modal>
  );
}

function PasswordDialog({ person, onClose }: { person: Person; onClose: () => void }) {
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const mismatch = !!again && next !== again;

  async function save() {
    setBusy(true);
    setError("");
    try {
      await api.post(`/users/${person.id}/password`, { password: next, current_password: current });
      toast(person.is_me ? "Password changed; other devices will need to sign in again" : `${person.first_name || person.username}'s password changed`);
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={person.is_me ? "Change your password" : `New password for ${person.first_name || person.username}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!next || next !== again || (person.is_me && !current)} onClick={save}>
            Change password
          </Button>
        </>
      }
    >
      <div className="stack" style={{ "--gap": "14px" } as React.CSSProperties}>
        {person.is_me && (
          <label className="field">
            <span>Current password</span>
            <input className="input" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" autoFocus />
          </label>
        )}
        <label className="field">
          <span>New password</span>
          <input className="input" type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" autoFocus={!person.is_me} />
          <small>At least 8 characters, not too common.{!person.is_me && " They'll be signed out everywhere."}</small>
        </label>
        <label className="field">
          <span>New password again</span>
          <input className="input" type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" />
          {mismatch && <small style={{ color: "var(--berry)" }}>These don't match.</small>}
        </label>
        {error && <Note tone="error">{error}</Note>}
      </div>
    </Modal>
  );
}
