import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Eye, Home, KeyRound, Mail, Pencil, RefreshCw, Send, Trash2, UserPlus, Users } from "lucide-react";
import { useState } from "react";
import { api } from "../api";
import { relative } from "../format";
import { useAction } from "../hooks/queries";
import { useMe } from "../hooks/session";
import type { Household, Invite, InviteSent, Person } from "../types";
import { Button, Modal, Note, errorText, useToast } from "./ui";

/**
 * Who can sign in. Super admins see everyone, grouped by household, invite new people and manage them. Whoever runs a
 * library (its household administrator) does the same for their own library. Anyone else sees the people they share
 * a library with, and manages only themselves.
 */
export function PeopleSection() {
  const me = useMe();
  const isAdmin = !!me?.is_admin;
  // Super admins manage everyone; a household administrator manages the people in their own library.
  const manages = isAdmin || !!me?.is_household_admin;
  const people = useQuery({ queryKey: ["people"], queryFn: () => api.get<Person[]>("/users") });
  const households = useQuery({ queryKey: ["households"], queryFn: () => api.get<Household[]>("/users/households"), enabled: isAdmin });
  const invites = useQuery({ queryKey: ["invites"], queryFn: () => api.get<Invite[]>("/users/invites"), enabled: manages });
  const [editing, setEditing] = useState<Person | "new" | null>(null);
  const [password, setPassword] = useState<Person | null>(null);
  const [inviting, setInviting] = useState(false);

  // Group by household, with the signed-in person's own household first.
  const groups = new Map<number, { name: string; people: Person[] }>();
  for (const p of people.data ?? []) {
    if (!groups.has(p.household_id)) groups.set(p.household_id, { name: p.household_name, people: [] });
    groups.get(p.household_id)!.people.push(p);
  }
  const ordered = [...groups.entries()].sort(([a], [b]) => (a === me?.household_id ? -1 : b === me?.household_id ? 1 : a - b));

  return (
    <section className="panel" id="people">
      <div className="panel-head">
        <Users size={18} />
        <h3>{isAdmin ? "People" : "Your library"}</h3>
        {manages && (
          <>
            <Button size="sm" variant="ghost" icon={<UserPlus size={15} />} onClick={() => setEditing("new")}>
              Add with a password
            </Button>
            <Button size="sm" variant="primary" icon={<Send size={15} />} onClick={() => setInviting(true)}>
              Invite someone
            </Button>
          </>
        )}
      </div>
      <p className="muted" style={{ marginBottom: 14 }}>
        {isAdmin
          ? "Everyone who can sign in, by library. People in the same library share its Audible books, podcasts and Yoto cards; different libraries never see each other's. Each person's Audible account decides which listening position they see."
          : manages
            ? "The people you share this library with. You run it: invite people into it, and change anyone's details or password here."
            : "The people you share this library with. You can change your own name, email, password and Audible account."}
      </p>
      {people.isError && <Note tone="error">{errorText(people.error)}</Note>}

      {manages && (invites.data ?? []).length > 0 && <PendingInvites invites={invites.data!} />}

      <div className="stack" style={{ "--gap": "18px" } as React.CSSProperties}>
        {ordered.map(([hid, group]) => (
          <div key={hid}>
            {(isAdmin || ordered.length > 1) && (
              <HouseholdHead name={group.name} household={households.data?.find((h) => h.id === hid)} isAdmin={isAdmin} mine={hid === me?.household_id} />
            )}
            <div className="list">
              {group.people.map((p) => (
                <PersonRow
                  key={p.id}
                  person={p}
                  isAdmin={isAdmin}
                  manages={manages}
                  sharedWith={group.people.filter((o) => o.id !== p.id).map((o) => o.first_name || o.username)}
                  onEdit={() => setEditing(p)}
                  onPassword={() => setPassword(p)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
      {editing && <PersonDialog person={editing === "new" ? null : editing} isAdmin={isAdmin} manages={manages} households={households.data ?? []} onClose={() => setEditing(null)} />}
      {password && <PasswordDialog person={password} onClose={() => setPassword(null)} />}
      {inviting && <InviteDialog superAdmin={isAdmin} onClose={() => setInviting(false)} />}
    </section>
  );
}

function HouseholdHead({ name, household, isAdmin, mine }: { name: string; household?: Household; isAdmin: boolean; mine: boolean }) {
  const toast = useToast();
  const share = useAction(
    (on: boolean) => api.patch(`/users/households/${household!.id}`, { share_my_ai_keys: on }),
    [["households"]],
  );
  return (
    <div className="household-head">
      <Home size={15} />
      <strong>{name}</strong>
      {mine && <span className="pill sky">Yours</span>}
      <span className="spacer" />
      {isAdmin && household && !mine && (
        <label className="check" style={{ fontSize: "var(--text-sm)" }} title="They can use Ask and Transcribe with your keys, without seeing them. Usage is billed to you.">
          <input
            type="checkbox"
            checked={!!household.shares_ai_keys_from}
            onChange={(e) =>
              share.mutate(e.target.checked, {
                onSuccess: () => toast(e.target.checked ? `${name} can use your AI keys` : `${name} uses only its own AI keys now`),
              })
            }
          />
          Can use our AI keys
        </label>
      )}
    </div>
  );
}

function PersonRow({
  person: p,
  isAdmin,
  manages,
  sharedWith,
  onEdit,
  onPassword,
}: {
  person: Person;
  isAdmin: boolean;
  manages: boolean;
  sharedWith: string[];
  onEdit: () => void;
  onPassword: () => void;
}) {
  const toast = useToast();
  const refresh: string[][] = [["people"], ["audible-accounts"], ["books"], ["session"]];
  const pickAccount = useAction(
    ({ id, account }: { id: number; account: number | null }) => api.patch(`/users/${id}`, { audible_account_id: account }),
    refresh,
  );
  const [removing, setRemoving] = useState(false);
  // A household administrator never manages a super admin (only a super admin does).
  const canManage = isAdmin || (manages && !p.is_admin);
  const canEdit = canManage || p.is_me;
  const qc = useQueryClient();

  async function viewAs(id: number) {
    try {
      await api.post(`/superadmin/impersonate/${id}`);
      qc.clear();
      window.location.assign("/");
    } catch (e) {
      toast(errorText(e), "error");
    }
  }
  const name = p.first_name || p.username;
  return (
    <div className="list-row person-row">
      <span className="avatar">{name.slice(0, 1).toUpperCase()}</span>
      <div style={{ minWidth: 0 }}>
        <div className="title">
          {name} {p.is_me && <span className="pill sky">You</span>} {p.is_admin && <span className="pill terracotta">Super admin</span>}{" "}
          {p.is_household_admin && <span className="pill sage">Runs this library</span>}{" "}
          {!p.onboarded && <span className="pill honey">Setting up</span>}
        </div>
        <div className="sub">
          <span>{p.email || p.username}</span>
          <span>signed in {relative(p.last_login)}</span>
        </div>
      </div>
      {canEdit && p.audible_accounts.length > 0 ? (
        <div className="person-audible">
          <label className="muted" style={{ fontSize: "var(--text-sm)" }} htmlFor={`audible-${p.id}`} title={`Whose Audible position ${name} sees`}>
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
                { onSuccess: () => toast(`Saved ${name}'s Audible account`) },
              )
            }
          >
            <option value="">First connected</option>
            {p.audible_accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </div>
      ) : (
        <span />
      )}
      <div className="actions">
        {isAdmin && !p.is_me && (
          <Button size="sm" iconOnly icon={<Eye size={14} />} aria-label={`View Audio as ${name}`} title={`View Audio as ${name}`} onClick={() => void viewAs(p.id)} />
        )}
        {canEdit && <Button size="sm" iconOnly icon={<Pencil size={14} />} aria-label={`Edit ${name}`} onClick={onEdit} />}
        {canEdit && <Button size="sm" iconOnly icon={<KeyRound size={14} />} aria-label={`Change ${name}'s password`} onClick={onPassword} />}
        {canManage && !p.is_me && (
          <Button
            size="sm"
            variant="danger"
            iconOnly
            icon={<Trash2 size={14} />}
            aria-label={`Remove ${name}`}
            onClick={() => setRemoving(true)}
          />
        )}
      </div>
      {removing && <RemoveDialog person={p} sharedWith={sharedWith} onClose={() => setRemoving(false)} />}
    </div>
  );
}

// ---------- invitations ----------

function PendingInvites({ invites }: { invites: Invite[] }) {
  const toast = useToast();
  const resend = useAction((id: number) => api.post<InviteSent>(`/users/invites/${id}/resend`), [["invites"]]);
  const cancel = useAction((id: number) => api.del(`/users/invites/${id}`), [["invites"]]);
  return (
    <div style={{ marginBottom: 18 }}>
      <div className="household-head">
        <Mail size={15} />
        <strong>Invited, not joined yet</strong>
      </div>
      <div className="list">
        {invites.map((i) => (
          <div key={i.id} className="list-row">
            <span className="avatar" style={{ opacity: 0.6 }}>{(i.name || i.email).slice(0, 1).toUpperCase()}</span>
            <div style={{ minWidth: 0 }}>
              <div className="title">
                {i.name || i.email} {i.expired ? <span className="pill berry">Expired</span> : <span className="pill honey">Invited</span>}
              </div>
              <div className="sub">
                {i.name && <span>{i.email}</span>}
                <span>{i.joining ? `Joins ${i.joining}` : "Their own library"}</span>
                {i.share_ai_keys && <span>uses our AI keys</span>}
                <span>{i.emailed_at ? `emailed ${relative(i.emailed_at)}` : `invited ${relative(i.created_at)}`}</span>
              </div>
            </div>
            <div className="actions">
              <Button size="sm" variant="ghost" icon={<Copy size={14} />} onClick={() => void copy(i.link).then((ok) => toast(ok ? "Link copied. Paste it into a message to them." : "Couldn't copy; the link is in the invite"))}>
                Copy link
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon={<RefreshCw size={14} />}
                onClick={() =>
                  resend.mutate(i.id, {
                    onSuccess: (r) => toast(r.emailed ? `Sent again to ${i.email}` : "Link renewed for two more weeks. Copy it and send it to them."),
                    onError: (e) => toast(errorText(e), "error"),
                  })
                }
              >
                {i.expired ? "Renew" : "Resend"}
              </Button>
              <Button size="sm" variant="danger" iconOnly icon={<Trash2 size={14} />} aria-label={`Delete ${i.email}'s invitation`} title="Delete invitation" onClick={() => confirm(`Delete the invitation to ${i.email}? The link stops working and it's gone for good.`) && cancel.mutate(i.id)} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function mailto(invite: Invite, inviter: string): string {
  const subject = `${inviter} invited you to Audio`;
  const body = `Hi${invite.name ? ` ${invite.name}` : ""},\n\nI've set you up on Audio, our family audiobook app. You can use it to put audiobooks and podcasts on Yoto cards, and to ask questions about the book you're listening to.\n\nOpen this link to choose a password. It walks you through the rest and takes about five minutes:\n${invite.link}\n`;
  return `mailto:${encodeURIComponent(invite.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function InviteDialog({ superAdmin, onClose }: { superAdmin: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const me = useMe();
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  // Whoever runs a library invites people into it; only a super admin makes a new library.
  const [join, setJoin] = useState(!superAdmin);
  const [shareKeys, setShareKeys] = useState(false);
  const [admin, setAdmin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState<InviteSent | null>(null);

  async function send() {
    setBusy(true);
    setError("");
    try {
      const result = await api.post<InviteSent>("/users/invites", { email, name, join_my_library: join, share_ai_keys: shareKeys, make_admin: admin });
      qc.invalidateQueries({ queryKey: ["invites"] });
      setSent(result);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    const who = sent.invite.name || sent.invite.email;
    return (
      <Modal title={sent.emailed ? `Invitation sent to ${who}` : `Send ${who} their link`} onClose={onClose} footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
        <div className="stack" style={{ "--gap": "14px" } as React.CSSProperties}>
          {sent.emailed ? (
            <p className="muted" style={{ margin: 0 }}>
              We emailed {sent.invite.email} a link. When they open it, they choose a password and the app walks them through
              connecting Audible and Yoto. If it doesn't arrive, you can also send them the link yourself:
            </p>
          ) : (
            <>
              {sent.email_error && <Note tone="warn">The email couldn't be sent ({sent.email_error}).</Note>}
              <p className="muted" style={{ margin: 0 }}>
                Send this link to {who} by email or text. When they open it, they choose a password and the app walks them
                through connecting Audible and Yoto. It works for two weeks.
              </p>
            </>
          )}
          <div className="input-with-button">
            <input className="input" readOnly value={sent.invite.link} onFocus={(e) => e.target.select()} aria-label="Invitation link" />
            <button type="button" onClick={() => void copy(sent.invite.link).then((ok) => toast(ok ? "Link copied" : "Select the link and copy it"))} aria-label="Copy link">
              <Copy size={16} />
            </button>
          </div>
          <a className="btn" href={mailto(sent.invite, me?.first_name || me?.username || "I")} style={{ alignSelf: "flex-start" }}>
            <Mail size={16} /> Write the email in my mail app
          </a>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title="Invite someone"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={<Send size={15} />} loading={busy} disabled={!email.includes("@")} onClick={send}>
            Send invitation
          </Button>
        </>
      }
    >
      <div className="stack" style={{ "--gap": "14px" } as React.CSSProperties}>
        <div className="grid-2">
          <label className="field">
            <span>Their name</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Grandma" autoFocus />
          </label>
          <label className="field">
            <span>Their email</span>
            <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" autoCapitalize="none" />
          </label>
        </div>
        {superAdmin ? (
        <div className="field">
          <span>Which library?</span>
          <div className="choices">
            <label>
              <input type="radio" name="library" checked={!join} onChange={() => setJoin(false)} />
              <strong>A library of their own</strong>
              <small>For another family. They connect their own Audible and Yoto, and see nothing of yours.</small>
            </label>
            <label>
              <input type="radio" name="library" checked={join} onChange={() => setJoin(true)} />
              <strong>Share {me?.household_name ?? "our library"}</strong>
              <small>Same Audible books, podcasts and Yoto cards as you. Good for someone in your home.</small>
            </label>
          </div>
        </div>
        ) : (
          <Note tone="info">They'll share {me?.household_name ?? "your library"}: the same Audible books, podcasts and Yoto cards as you.</Note>
        )}
        {!join && (
          <label className="check">
            <input type="checkbox" checked={shareKeys} onChange={(e) => setShareKeys(e.target.checked)} />
            <span>
              Let them use our AI keys for Ask and Transcribe
              <small className="muted" style={{ display: "block" }}>They never see the keys. Their usage is billed to you. You can turn this off later.</small>
            </span>
          </label>
        )}
        {superAdmin && (
        <label className="check">
          <input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} />
          <span>
            Make them a super admin
            <small className="muted" style={{ display: "block" }}>They could invite and remove people, and change anyone's password.</small>
          </span>
        </label>
        )}
        {error && <Note tone="error">{error}</Note>}
      </div>
    </Modal>
  );
}

// ---------- editing ----------

function PersonDialog({ person, isAdmin, manages, households, onClose }: { person: Person | null; isAdmin: boolean; manages: boolean; households: Household[]; onClose: () => void }) {
  const qc = useQueryClient();
  const me = useMe();
  const toast = useToast();
  const [username, setUsername] = useState(person?.username ?? "");
  const [firstName, setFirstName] = useState(person?.first_name ?? "");
  const [email, setEmail] = useState(person?.email ?? "");
  const [admin, setAdmin] = useState(person?.is_admin ?? false);
  const [runs, setRuns] = useState(person?.is_household_admin ?? false);
  const [password, setPassword] = useState("");
  const [household, setHousehold] = useState<number>(person?.household_id ?? me?.household_id ?? 0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError("");
    const body = {
      username,
      first_name: firstName,
      email,
      ...(isAdmin ? { is_admin: admin, household_id: household || undefined } : {}),
      ...(manages ? { is_household_admin: runs } : {}),
    };
    try {
      if (person) await api.patch(`/users/${person.id}`, body);
      else await api.post("/users", { ...body, password });
      for (const key of ["people", "session", "audible-accounts", "books", "households"]) qc.invalidateQueries({ queryKey: [key] });
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
      title={person ? `Edit ${person.first_name || person.username}` : "Add a person with a password"}
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
        {!person && <Note tone="info">Usually it's easier to invite them by email: they choose their own password and get walked through setup.</Note>}
        <div className="grid-2">
          <label className="field">
            <span>Name</span>
            <input className="input" value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="Sam" autoFocus />
          </label>
          <label className="field">
            <span>Username</span>
            <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoCapitalize="none" autoComplete="off" />
            <small>They can sign in with this or their email.</small>
          </label>
        </div>
        <label className="field">
          <span>Email</span>
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Optional" />
        </label>
        {!person && (
          <label className="field">
            <span>Password</span>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
            <small>At least 8 characters, not too common. Tell them, and they can change it later.</small>
          </label>
        )}
        {isAdmin && households.length > 0 && (
          <label className="field">
            <span>Library</span>
            <select className="select" value={household} onChange={(e) => setHousehold(Number(e.target.value))}>
              {households.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                  {h.members.length ? ` (${h.members.join(", ")})` : ""}
                </option>
              ))}
            </select>
            <small>Moving someone takes them to that library's books and cards; their own Audible choice resets.</small>
          </label>
        )}
        {manages && (
          <label className="check">
            <input type="checkbox" checked={runs} onChange={(e) => setRuns(e.target.checked)} />
            Runs this library: can invite people into it, and change or remove the people in it
          </label>
        )}
        {isAdmin && (
          <label className="check">
            <input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} />
            Super admin: can invite and remove people and change their passwords, in every library
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

/** Remove a login, or delete the person completely: their library too when nobody else uses it. */
function RemoveDialog({ person, sharedWith, onClose }: { person: Person; sharedWith: string[]; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const name = person.first_name || person.username;
  const [everything, setEverything] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const shared = sharedWith.length > 0;

  async function remove() {
    setBusy(true);
    setError("");
    try {
      const result = await api.del<{ library_deleted: boolean }>(`/users/${person.id}${everything ? "?everything=true" : ""}`);
      for (const key of ["people", "households", "invites", "superadmin"]) qc.invalidateQueries({ queryKey: [key] });
      toast(result.library_deleted ? `Deleted ${name} and their library` : `Removed ${name}`);
      onClose();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Remove ${name}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="danger" icon={<Trash2 size={15} />} loading={busy} onClick={() => void remove()}>
            {everything ? "Delete everything" : "Remove login"}
          </Button>
        </>
      }
    >
      <div className="stack" style={{ "--gap": "14px" } as React.CSSProperties}>
        <div className="choices">
          <label>
            <input type="radio" name="remove-how" checked={everything} onChange={() => setEverything(true)} />
            <strong>Delete completely, as if they'd never been here</strong>
            <small>
              Their login, conversations and invitation
              {shared
                ? `. Their library stays, because ${sharedWith.join(" and ")} still use${sharedWith.length === 1 ? "s" : ""} it.`
                : ", and their whole library: Audible accounts (signed out at Amazon too), books and downloaded audio, podcasts, folders, Yoto cards made here, AI keys and settings."}
            </small>
          </label>
          <label>
            <input type="radio" name="remove-how" checked={!everything} onChange={() => setEverything(false)} />
            <strong>Just stop them signing in</strong>
            <small>Their library and everything in it stays here.</small>
          </label>
        </div>
        {everything && !shared && (
          <Note tone="warn">This can't be undone. Cards already on their Yoto account stay there; delete those in the Yoto app if you want.</Note>
        )}
        {error && <Note tone="error">{error}</Note>}
      </div>
    </Modal>
  );
}
