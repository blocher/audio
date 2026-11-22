import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AudioLines, Eye, EyeOff } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { Button, Note, Spinner, errorText } from "../components/ui";
import type { Session } from "../types";

interface InviteInfo {
  email: string;
  name: string;
  inviter: string;
  joining: string | null;
  status: "ok" | "expired" | "accepted";
  has_login: boolean;
}

/** Where an invitation email's link lands: pick a name and password, and you're in. */
export default function AcceptInvite() {
  const { token = "" } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const info = useQuery({ queryKey: ["invite", token], queryFn: () => api.get<InviteInfo>(`/auth/invites/${token}`), retry: false });
  const [typedName, setName] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.get<Session>("/auth/session"); // make sure the CSRF cookie exists
      const session = await api.post<Session>(`/auth/invites/${token}/accept`, { name, password });
      qc.setQueryData(["session"], session);
      navigate("/welcome", { replace: true });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const data = info.data;
  const name = typedName ?? data?.name ?? "";
  const usable = data?.status === "ok" && !data.has_login;

  return (
    <div className="login">
      <section className="login-art">
        <div className="brand" style={{ padding: 0 }}>
          <AudioLines size={28} /> Audio
        </div>
        <div className="stack" style={{ "--gap": "18px" } as React.CSSProperties}>
          <h1>{data?.inviter ? `${data.inviter} invited you.` : "You're invited."}</h1>
          <p>
            Your audiobooks and podcasts in one place, ready to put on Yoto cards or to ask questions about while you
            listen.
          </p>
        </div>
        <span style={{ color: "var(--walnut-muted)", fontSize: "var(--text-sm)" }}>A private family library</span>
      </section>
      <section className="login-form">
        {info.isLoading ? (
          <Spinner size={26} />
        ) : info.isError || !data ? (
          <div className="stack" style={{ "--gap": "16px", width: "min(360px, 100%)" } as React.CSSProperties}>
            <h2>This link doesn't work</h2>
            <Note tone="error">{errorText(info.error)}</Note>
            <Link to="/" className="btn">Go to sign in</Link>
          </div>
        ) : !usable ? (
          <div className="stack" style={{ "--gap": "16px", width: "min(360px, 100%)" } as React.CSSProperties}>
            <h2>{data.status === "expired" ? "This invitation has expired" : "You're already signed up"}</h2>
            <p className="muted">
              {data.status === "expired"
                ? `Ask ${data.inviter || "whoever invited you"} to send a new one. It only takes them a moment.`
                : `Sign in with ${data.email} and the password you chose.`}
            </p>
            {data.status !== "expired" && <Link to="/" className="btn primary lg">Go to sign in</Link>}
          </div>
        ) : (
          <form onSubmit={submit} className="stack" style={{ "--gap": "16px" } as React.CSSProperties}>
            <div>
              <h2>Create your login</h2>
              <p className="muted">
                {data.joining ? (
                  <>You'll share <b>{data.joining}</b>: the same audiobooks and Yoto cards.</>
                ) : (
                  <>You'll get a library of your own. Next, we'll help you connect Audible and Yoto.</>
                )}
              </p>
            </div>
            {error && <Note tone="error">{error}</Note>}
            <label className="field">
              <span>Your name</span>
              <input className="input" autoComplete="given-name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus={!name} />
            </label>
            <label className="field">
              <span>Email</span>
              <input className="input" value={data.email} readOnly disabled />
              <small>You'll sign in with this.</small>
            </label>
            <label className="field">
              <span>Choose a password</span>
              <div className="input-with-button">
                <input
                  className="input"
                  type={show ? "text" : "password"}
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={8}
                  autoFocus={!!name}
                />
                <button type="button" onClick={() => setShow((s) => !s)} aria-label={show ? "Hide password" : "Show password"}>
                  {show ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </div>
              <small>At least 8 characters. A short phrase like “purple tea kettle” works well.</small>
            </label>
            <Button variant="primary" size="lg" type="submit" loading={busy} disabled={!name.trim() || password.length < 8}>
              Create my login
            </Button>
          </form>
        )}
      </section>
    </div>
  );
}
