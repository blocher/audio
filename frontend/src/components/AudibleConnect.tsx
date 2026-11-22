import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ClipboardPaste, ExternalLink } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { AudibleAccount } from "../types";
import { Button, Note, Spinner, errorText, useToast } from "./ui";

const isTouch = typeof navigator !== "undefined" && /iPad|iPhone|iPod|Android/i.test(navigator.userAgent + (navigator.maxTouchPoints > 1 ? " iPad" : ""));

/**
 * A drawing of the page Amazon ends on, so nobody thinks it broke: an error page, with the address bar to copy.
 */
function ExpectedPage() {
  return (
    <figure className="amazon-mock" aria-label="What Amazon shows after you sign in">
      <div className="amazon-mock-bar">
        <span className="dots" aria-hidden>
          <i />
          <i />
          <i />
        </span>
        <span className="amazon-mock-url">
          <b>amazon.com/ap/maplanding</b>?openid.assoc_handle=amzn_audible…
        </span>
        <span className="amazon-mock-arrow">Copy this</span>
      </div>
      <div className="amazon-mock-page">
        <div className="amazon-mock-logo">amazon</div>
        <strong>Looking for something?</strong>
        <span>We're sorry. The Web address you entered is not a functioning page on our site.</span>
      </div>
      <figcaption>
        <CheckCircle2 size={16} />
        <span>
          This error page means it <b>worked</b>. Copy the address at the top.
        </span>
      </figcaption>
    </figure>
  );
}

/**
 * Signing an Audible account in, step by step. Amazon has no sign-in button for other apps, so the person signs in on
 * Amazon's page and pastes back the address it lands on. Coming back to this tab picks the address up from the
 * clipboard when the browser allows it, and a right-looking address connects straight away.
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
  const looksRight = pasted.includes("maplanding");

  useEffect(() => {
    api
      .post<{ login_url: string }>(`/audible/accounts/${account.id}/login/start`)
      .then((r) => setLoginUrl(r.login_url))
      .catch((e) => setError(errorText(e)));
  }, [account.id]);

  // Back from Amazon's tab: if the address is on the clipboard, take it (browsers that ask first just say no).
  useEffect(() => {
    if (!opened || looksRight) return;
    const onBack = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const text = (await navigator.clipboard.readText()).trim();
        if (text.includes("maplanding")) setPasted(text);
      } catch {
        /* needs a tap first: the Paste button does it */
      }
    };
    window.addEventListener("focus", onBack);
    document.addEventListener("visibilitychange", onBack);
    return () => {
      window.removeEventListener("focus", onBack);
      document.removeEventListener("visibilitychange", onBack);
    };
  }, [opened, looksRight]);

  async function pasteFromClipboard() {
    try {
      setPasted((await navigator.clipboard.readText()).trim());
    } catch {
      setError("Your browser didn't allow pasting. Press and hold in the box below and choose Paste.");
    }
  }

  async function finish(url = pasted) {
    setBusy(true);
    setError("");
    try {
      await api.post(`/audible/accounts/${account.id}/login/finish`, { redirect_url: url });
      for (const key of ["audible-accounts", "jobs", "onboarding", "books"]) qc.invalidateQueries({ queryKey: [key] });
      toast(`${account.name}'s Audible is connected. Your books are loading now.`);
      onConnected();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  // The right address connects by itself: one less button to find.
  const tried = useRef("");
  useEffect(() => {
    if (looksRight && !busy && tried.current !== pasted) {
      tried.current = pasted;
      void finish(pasted);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [looksRight, pasted]);

  return (
    <div className="stack" style={{ "--gap": "18px" } as React.CSSProperties}>
      <ol className="big-steps">
        <li className={opened ? "done" : "current"}>
          <span className="big-n">{opened ? <CheckCircle2 size={18} /> : 1}</span>
          <div className="stack" style={{ "--gap": "8px" } as React.CSSProperties}>
            <strong>Sign in on Amazon</strong>
            <span className="muted">Use your Audible email and password. Amazon may text you a code; that's normal.</span>
            {loginUrl ? (
              <a
                className={`btn ${opened ? "" : "primary lg"}`}
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
        <li className={opened && !looksRight ? "current" : looksRight ? "done" : ""}>
          <span className="big-n">{looksRight ? <CheckCircle2 size={18} /> : 2}</span>
          <div className="stack" style={{ "--gap": "10px" } as React.CSSProperties}>
            <strong>Amazon will show an error page. That's what you want!</strong>
            <ExpectedPage />
            <span className="muted">
              {isTouch
                ? "Tap the address bar at the top, then tap and hold the address and choose Copy (or use the Share button → Copy)."
                : "Click the address bar at the top, press Ctrl+C (⌘C on a Mac) to copy it, then come back to this tab."}
            </span>
          </div>
        </li>
        <li className={looksRight ? "current" : ""}>
          <span className="big-n">3</span>
          <div className="stack" style={{ "--gap": "8px" } as React.CSSProperties}>
            <strong>Come back to this tab and paste it</strong>
            {canPaste && (
              <Button variant={opened ? "primary" : undefined} icon={<ClipboardPaste size={15} />} onClick={pasteFromClipboard} style={{ alignSelf: "flex-start" }}>
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
                That isn't the right address yet. It should have “maplanding” in it: copy it from the error page, after
                you've signed in.
              </small>
            )}
            {looksRight && busy && (
              <small style={{ color: "var(--sage-strong)" }}>
                <Spinner size={13} /> That's it. Connecting…
              </small>
            )}
          </div>
        </li>
      </ol>
      {error && <Note tone="error">{error}</Note>}
      {looksRight && !busy && error && (
        <Button variant="primary" size="lg" onClick={() => void finish()} style={{ alignSelf: "flex-start" }}>
          Try connecting again
        </Button>
      )}
    </div>
  );
}
