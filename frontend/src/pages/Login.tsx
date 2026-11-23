import { useQueryClient } from "@tanstack/react-query";
import { AudioLines, LogIn, Mail } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api";
import { Button, Note, errorText } from "../components/ui";
import { useSession } from "../hooks/session";
import type { Session } from "../types";

export default function Login() {
  const qc = useQueryClient();
  const canReset = !!useSession().data?.can_reset_password;
  const [params, setParams] = useSearchParams();
  const forgot = canReset && params.get("forgot") === "1";
  const setForgot = (on: boolean) => setParams(on ? { forgot: "1" } : {}, { replace: true });
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.get<Session>("/auth/session"); // make sure the CSRF cookie exists
      const session = await api.post<Session>("/auth/login", { username, password });
      qc.setQueryData(["session"], session);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't sign in");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <section className="login-art">
        <div className="brand" style={{ padding: 0 }}>
          <AudioLines size={28} /> Audio
        </div>
        <div className="stack" style={{ "--gap": "18px" } as React.CSSProperties}>
          <h1>Good stories, all in one place.</h1>
          <p>Audible libraries, podcasts and your own recordings — ready to listen, ask about, and pack onto Yoto cards.</p>
        </div>
        <span style={{ color: "var(--walnut-muted)", fontSize: "var(--text-sm)" }}>A private family library</span>
      </section>
      <section className="login-form">
        {forgot ? (
          <Forgot email={username.includes("@") ? username : ""} onBack={() => setForgot(false)} />
        ) : (
        <form onSubmit={submit} className="stack" style={{ "--gap": "16px" } as React.CSSProperties}>
          <div>
            <h2>Welcome back</h2>
            <p className="muted">Sign in to your library.</p>
          </div>
          {error && <Note tone="error">{error}</Note>}
          <label className="field">
            <span>Email or username</span>
            <input
              className="input"
              autoComplete="username"
              autoCapitalize="none"
              inputMode="email"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
              required
            />
          </label>
          <label className="field">
            <span>Password</span>
            <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </label>
          <Button variant="primary" size="lg" type="submit" loading={busy} icon={<LogIn size={18} />}>
            Sign in
          </Button>
          {canReset && (
            <button type="button" className="link-button" onClick={() => setForgot(true)}>
              Forgot your password?
            </button>
          )}
          <p className="muted" style={{ fontSize: "var(--text-sm)", margin: 0 }}>
            New here? Open the invitation link in your email to make your login.
            {!canReset && " Forgot your password? Ask whoever invited you to set a new one."}
          </p>
        </form>
        )}
      </section>
    </div>
  );
}

/** "Forgot your password?": email a link to choose a new one. It says the same thing whether or not the address has a login. */
function Forgot({ email: typed, onBack }: { email: string; onBack: () => void }) {
  const [email, setEmail] = useState(typed);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.get<Session>("/auth/session"); // make sure the CSRF cookie exists
      await api.post("/auth/password/forgot", { email });
      setSent(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  if (sent)
    return (
      <div className="stack" style={{ "--gap": "16px", width: "min(360px, 100%)" } as React.CSSProperties}>
        <div>
          <h2>Check your email</h2>
          <p className="muted">
            If <b>{email}</b> has a login here, a link to choose a new password is on its way. It works once, for two hours.
            Nothing there after a few minutes? Check your spam folder.
          </p>
        </div>
        <Button size="lg" onClick={onBack}>
          Back to sign in
        </Button>
      </div>
    );
  return (
    <form onSubmit={submit} className="stack" style={{ "--gap": "16px" } as React.CSSProperties}>
      <div>
        <h2>Forgot your password?</h2>
        <p className="muted">Type the email you sign in with, and we'll send you a link to choose a new one.</p>
      </div>
      {error && <Note tone="error">{error}</Note>}
      <label className="field">
        <span>Email</span>
        <input
          className="input"
          type="email"
          autoComplete="username"
          autoCapitalize="none"
          inputMode="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoFocus
          required
        />
      </label>
      <Button variant="primary" size="lg" type="submit" loading={busy} icon={<Mail size={18} />}>
        Email me a link
      </Button>
      <button type="button" className="link-button" onClick={onBack}>
        Back to sign in
      </button>
    </form>
  );
}
