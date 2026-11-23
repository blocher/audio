import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AudioLines, Eye, EyeOff, KeyRound } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { Button, Note, Spinner, errorText } from "../components/ui";
import type { Session } from "../types";

interface ResetInfo {
  valid: boolean;
  email: string;
  name: string;
}

/** Where a "forgot your password" email's link lands: choose a new password, and you're signed in. */
export default function ResetPassword() {
  const { uid = "", token = "" } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const info = useQuery({
    queryKey: ["password-reset", uid, token],
    queryFn: () => api.get<ResetInfo>(`/auth/password/reset/${uid}/${token}`),
    retry: false,
    staleTime: Infinity,
  });
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
      const session = await api.post<Session>(`/auth/password/reset/${uid}/${token}`, { password });
      qc.setQueryData(["session"], session);
      navigate("/library", { replace: true });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const data = info.data;
  return (
    <div className="login">
      <section className="login-art">
        <div className="brand" style={{ padding: 0 }}>
          <AudioLines size={28} /> Audio
        </div>
        <div className="stack" style={{ "--gap": "18px" } as React.CSSProperties}>
          <h1>{data?.name ? `Welcome back, ${data.name}.` : "A fresh start."}</h1>
          <p>Choose a new password and you'll be straight back in your library.</p>
        </div>
        <span style={{ color: "var(--walnut-muted)", fontSize: "var(--text-sm)" }}>A private family library</span>
      </section>
      <section className="login-form">
        {info.isLoading ? (
          <Spinner size={26} />
        ) : !data?.valid ? (
          <div className="stack" style={{ "--gap": "16px", width: "min(360px, 100%)" } as React.CSSProperties}>
            <h2>This link has run out</h2>
            <p className="muted">
              Reset links work once, for two hours. Ask for a new one from the sign-in page; it only takes a moment.
            </p>
            <Link to="/?forgot=1" className="btn primary lg">
              Send me a new link
            </Link>
          </div>
        ) : (
          <form onSubmit={submit} className="stack" style={{ "--gap": "16px" } as React.CSSProperties}>
            <div>
              <h2>Choose a new password</h2>
              <p className="muted">For {data.email}.</p>
            </div>
            {error && <Note tone="error">{error}</Note>}
            {/* Lets password managers save the new password against the right login. */}
            <input type="email" autoComplete="username" value={data.email} readOnly hidden />
            <label className="field">
              <span>New password</span>
              <div className="input-with-button">
                <input
                  className="input"
                  type={show ? "text" : "password"}
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={8}
                  autoFocus
                />
                <button type="button" onClick={() => setShow((s) => !s)} aria-label={show ? "Hide password" : "Show password"}>
                  {show ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </div>
              <small>At least 8 characters. A short phrase like “purple tea kettle” works well.</small>
            </label>
            <Button variant="primary" size="lg" type="submit" icon={<KeyRound size={18} />} loading={busy} disabled={password.length < 8}>
              Save and sign in
            </Button>
          </form>
        )}
      </section>
    </div>
  );
}
