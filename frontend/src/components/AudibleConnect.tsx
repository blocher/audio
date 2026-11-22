import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ClipboardPaste, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import type { AudibleAccount } from "../types";
import { Button, Note, Spinner, errorText, useToast } from "./ui";

/**
 * Signing an Audible account in, step by step. Amazon has no sign-in button for other apps, so the person signs in on
 * Amazon's page and pastes back the address it lands on.
 */
export function AudibleSignInSteps({ account, onConnected }: { account: AudibleAccount; onConnected: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [loginUrl, setLoginUrl] = useState("");
  const [opened, setOpened] = useState(false);
  const [pasted, setPasted] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const canPaste = typeof navigator !== "undefined" && !!navigator.clipboard?.readText;

  useEffect(() => {
    api
      .post<{ login_url: string }>(`/audible/accounts/${account.id}/login/start`)
      .then((r) => setLoginUrl(r.login_url))
      .catch((e) => setError(errorText(e)));
  }, [account.id]);

  async function pasteFromClipboard() {
    try {
      setPasted((await navigator.clipboard.readText()).trim());
    } catch {
      setError("Your browser didn't allow pasting. Press and hold in the box below and choose Paste.");
    }
  }

  async function finish() {
    setBusy(true);
    setError("");
    try {
      await api.post(`/audible/accounts/${account.id}/login/finish`, { redirect_url: pasted });
      for (const key of ["audible-accounts", "jobs", "onboarding", "books"]) qc.invalidateQueries({ queryKey: [key] });
      toast(`${account.name}'s Audible is connected. Your books are loading now.`);
      onConnected();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const looksRight = pasted.includes("maplanding");

  return (
    <div className="stack" style={{ "--gap": "16px" } as React.CSSProperties}>
      <ol className="steps">
        <li>
          <div className="stack" style={{ "--gap": "8px" } as React.CSSProperties}>
            <strong>Sign in on Amazon</strong>
            <span className="muted" style={{ fontSize: "var(--text-sm)" }}>
              Use the email and password you use for Audible. Amazon may ask for a code it texts or emails you, or a
              picture puzzle. That's normal.
            </span>
            {loginUrl ? (
              <a
                className={`btn ${opened ? "" : "primary"}`}
                href={loginUrl}
                target="_blank"
                rel="noreferrer"
                style={{ alignSelf: "flex-start" }}
                onClick={() => setOpened(true)}
              >
                <ExternalLink size={16} /> {opened ? "Open Amazon again" : "Open Amazon sign-in"}
              </a>
            ) : (
              !error && <Spinner />
            )}
          </div>
        </li>
        <li>
          <div className="stack" style={{ "--gap": "8px" } as React.CSSProperties}>
            <strong>Copy the address of the page Amazon ends on</strong>
            <span className="muted" style={{ fontSize: "var(--text-sm)" }}>
              After you sign in, Amazon shows a page that looks broken, like “Page not found”. <b>That's expected.</b>{" "}
              Copy the web address at the top of that page: on a computer, click the address bar and copy it; on a phone,
              press and hold the address bar and tap Copy.
            </span>
          </div>
        </li>
        <li>
          <div className="stack" style={{ "--gap": "8px" } as React.CSSProperties}>
            <strong>Come back here and paste it</strong>
            {canPaste && (
              <Button size="sm" icon={<ClipboardPaste size={15} />} onClick={pasteFromClipboard} style={{ alignSelf: "flex-start" }}>
                Paste what I copied
              </Button>
            )}
            <textarea
              className="textarea"
              value={pasted}
              onChange={(e) => setPasted(e.target.value.trim())}
              placeholder="https://www.amazon.com/ap/maplanding?…"
              aria-label="The address Amazon ended on"
            />
            {pasted && !looksRight && (
              <small style={{ color: "var(--berry)" }}>
                That doesn't look like the right address yet. It should contain the word “maplanding”. Make sure you
                copied it after signing in.
              </small>
            )}
            {looksRight && (
              <small style={{ color: "var(--sage-strong)" }}>
                <CheckCircle2 size={13} style={{ verticalAlign: "-2px" }} /> That looks right.
              </small>
            )}
          </div>
        </li>
      </ol>
      {error && <Note tone="error">{error}</Note>}
      <Button variant="primary" size="lg" disabled={!looksRight} loading={busy} onClick={finish} style={{ alignSelf: "flex-start" }}>
        Connect Audible
      </Button>
    </div>
  );
}
