import { useQueryClient } from "@tanstack/react-query";
import { AudioLines, LogIn } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api } from "../api";
import { Button, Note } from "../components/ui";
import type { Session } from "../types";

export default function Login() {
  const qc = useQueryClient();
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
        <form onSubmit={submit} className="stack" style={{ "--gap": "16px" } as React.CSSProperties}>
          <div>
            <h2>Welcome back</h2>
            <p className="muted">Sign in to your library.</p>
          </div>
          {error && <Note tone="error">{error}</Note>}
          <label className="field">
            <span>Username</span>
            <input className="input" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus required />
          </label>
          <label className="field">
            <span>Password</span>
            <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </label>
          <Button variant="primary" size="lg" type="submit" loading={busy} icon={<LogIn size={18} />}>
            Sign in
          </Button>
        </form>
      </section>
    </div>
  );
}
