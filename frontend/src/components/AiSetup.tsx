import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ChevronDown, ClipboardPaste, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import { connectInPopup, openPopup } from "../connect";
import { PROVIDER_USES } from "../providers";
import type { SettingsData } from "../types";
import { Button, Note, errorText, useToast } from "./ui";

const RECOMMENDED = "openai";
const KEY_SHAPE = /^sk-[\w-]{20,}$/;

/**
 * Setting up Ask without leaving the app. The easiest way is OpenRouter's sign-in, which hands the app a key in a
 * popup. Otherwise one OpenAI key, opened beside the app and picked up from the clipboard when they come back.
 */
export function AiQuickSetup({ onSaved }: { onSaved?: () => void }) {
  const [way, setWay] = useState<"connect" | "key">("connect");
  return (
    <div className="stack" style={{ "--gap": "16px", width: "100%" } as React.CSSProperties}>
      <div className="choices">
        <label>
          <input type="radio" name="ai-way" checked={way === "connect"} onChange={() => setWay("connect")} />
          <strong>
            Connect with OpenRouter <span className="pill sage">Easiest</span>
          </strong>
          <small>Sign in with Google or email in a small window. No keys to copy.</small>
        </label>
        <label>
          <input type="radio" name="ai-way" checked={way === "key"} onChange={() => setWay("key")} />
          <strong>Paste a key from OpenAI or another company</strong>
          <small>If you already have one, or prefer to pay OpenAI directly.</small>
        </label>
      </div>
      {way === "connect" ? <OpenRouterConnect onSaved={onSaved} /> : <KeySetup onSaved={onSaved} />}
    </div>
  );
}

/** One button: OpenRouter's sign-in opens in a popup and hands this app a key of the person's own. */
export function OpenRouterConnect({ onSaved, compact }: { onSaved?: () => void; compact?: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function connect() {
    setBusy(true);
    setError("");
    try {
      const { url } = await api.post<{ url: string }>("/connect/openrouter/start", {
        popup: true,
        return_to: window.location.pathname + window.location.search,
      });
      const result = await connectInPopup(url, "openrouter");
      for (const k of ["settings", "ai-models", "onboarding"]) qc.invalidateQueries({ queryKey: [k] });
      if (result.error) setError(result.error);
      else {
        toast("OpenRouter is connected. Ask and Transcribe are ready.");
        onSaved?.();
      }
    } catch (e) {
      if (!(e instanceof Error && e.message === "closed")) setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack" style={{ "--gap": "12px" } as React.CSSProperties}>
      {!compact && (
        <p className="muted" style={{ margin: 0 }}>
          OpenRouter is one account for AI from OpenAI, Anthropic and Google. A window opens: sign in (Google works),
          add some credit if it asks ($5 lasts a long time), then click <b>Authorize</b>. It closes by itself, and you're
          done. You can set a spending limit, or disconnect, on OpenRouter any time.
        </p>
      )}
      {error && <Note tone="error">{error}</Note>}
      <Button variant="primary" size={compact ? undefined : "lg"} loading={busy} onClick={() => void connect()} style={{ alignSelf: "flex-start" }}>
        Connect with OpenRouter
      </Button>
    </div>
  );
}

/** Paste-a-key: one recommended provider with click-by-click steps, others tucked away. */
function KeySetup({ onSaved }: { onSaved?: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api.get<SettingsData>("/settings") });
  const [provider, setProvider] = useState(RECOMMENDED);
  const [key, setKey] = useState("");
  const [others, setOthers] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const providers = settings.data?.providers ?? [];
  const chosen = providers.find((p) => p.id === provider);
  const [waiting, setWaiting] = useState(false);

  // After they open OpenAI's key page, pick the key up from the clipboard as soon as they come back to this window.
  useEffect(() => {
    if (!waiting) return;
    const onFocus = async () => {
      try {
        const text = (await navigator.clipboard.readText()).trim();
        if (KEY_SHAPE.test(text)) {
          setKey(text);
          setWaiting(false);
          toast("We pasted the key you copied. Click Save key.");
        }
      } catch {
        /* the browser wants a tap first; the Paste button handles that */
      }
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [waiting, toast]);

  async function pasteFromClipboard() {
    try {
      setKey((await navigator.clipboard.readText()).trim());
    } catch {
      setError("Your browser didn't allow pasting. Press and hold in the box and choose Paste.");
    }
  }

  async function save() {
    setBusy(true);
    setError("");
    try {
      await api.put("/settings", { service: provider, values: { api_key: key.trim() } });
      // Check the key works by listing its models; a bad key shows its error here rather than later in Ask.
      const catalog = await api.get<{ providers: { provider: string; error: string }[] }>("/ai/models?kind=chat&refresh=true");
      const problem = catalog.providers.find((p) => p.provider === provider)?.error;
      for (const k of ["settings", "ai-models", "onboarding"]) qc.invalidateQueries({ queryKey: [k] });
      if (problem) {
        setError(`The key was saved, but ${chosen?.label ?? provider} said: ${problem}. Check you copied all of it.`);
        return;
      }
      setKey("");
      toast(`${chosen?.label ?? "AI"} is connected`);
      onSaved?.();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack" style={{ "--gap": "16px" } as React.CSSProperties}>
      {provider === RECOMMENDED ? (
        <>
          <p className="muted" style={{ margin: 0 }}>
            We suggest <b>OpenAI</b> (the company behind ChatGPT): one key does both. It's pay-as-you-go. Transcribing a
            10-hour audiobook costs about $3.60, and each question costs a cent or two.
          </p>
          <ol className="steps">
            <li>
              <div className="stack" style={{ "--gap": "6px" } as React.CSSProperties}>
                <strong>Open OpenAI's key page and sign in</strong>
                <span className="muted" style={{ fontSize: "var(--text-sm)" }}>
                  A ChatGPT login works. If it's your first time, OpenAI asks you to add a payment card and some credit
                  ($5 lasts a long time).
                </span>
                <Button
                  icon={<ExternalLink size={16} />}
                  style={{ alignSelf: "flex-start" }}
                  onClick={() => {
                    setWaiting(true);
                    if (!openPopup("https://platform.openai.com/api-keys", "openai-keys")) {
                      window.open("https://platform.openai.com/api-keys", "_blank", "noreferrer");
                    }
                  }}
                >
                  Open OpenAI beside this window
                </Button>
              </div>
            </li>
            <li>
              <div className="stack" style={{ "--gap": "6px" } as React.CSSProperties}>
                <strong>Click “Create new secret key”</strong>
                <span className="muted" style={{ fontSize: "var(--text-sm)" }}>
                  Name it “Audio”, leave the other options as they are, and click Create. Then click Copy.
                </span>
              </div>
            </li>
            <li>
              <div className="stack" style={{ "--gap": "6px" } as React.CSSProperties}>
                <strong>Come back here</strong>
                <span className="muted" style={{ fontSize: "var(--text-sm)" }}>
                  We'll paste the key for you when you return to this window. If not, tap Paste.
                </span>
                <div className="row" style={{ gap: 8 }}>
                  <KeyInput value={key} onChange={setKey} placeholder="sk-…" />
                  {!!navigator.clipboard?.readText && (
                    <Button icon={<ClipboardPaste size={15} />} onClick={() => void pasteFromClipboard()}>Paste</Button>
                  )}
                </div>
              </div>
            </li>
          </ol>
        </>
      ) : (
        <div className="stack" style={{ "--gap": "8px" } as React.CSSProperties}>
          <strong>{chosen?.label} key</strong>
          <span className="muted" style={{ fontSize: "var(--text-sm)" }}>
            {PROVIDER_USES[provider]}.{" "}
            {chosen && (
              <a href={chosen.key_url} target="_blank" rel="noreferrer" style={{ color: "var(--terracotta)" }}>
                Get a key <ExternalLink size={12} style={{ verticalAlign: "-1px" }} />
              </a>
            )}
          </span>
          <KeyInput value={key} onChange={setKey} placeholder="Paste the key" />
          {(provider === "anthropic" || provider === "xai") && (
            <small className="muted">This one can't transcribe, so you'll also want OpenAI, Gemini or Groq for that.</small>
          )}
        </div>
      )}
      {error && <Note tone="error">{error}</Note>}
      <div className="row" style={{ flexWrap: "wrap", gap: 10 }}>
        <Button variant="primary" disabled={key.trim().length < 10} loading={busy} onClick={save}>
          Save key
        </Button>
        <button type="button" className="link-btn" onClick={() => setOthers((o) => !o)} aria-expanded={others}>
          Use a different company <ChevronDown size={14} style={{ verticalAlign: "-2px", transform: others ? "rotate(180deg)" : undefined }} />
        </button>
      </div>
      {others && (
        <div className="choices">
          {providers.map((p) => {
            const saved = settings.data?.[p.id]?.api_key;
            return (
              <label key={p.id}>
                <input type="radio" name="ai-provider" checked={provider === p.id} onChange={() => (setProvider(p.id), setError(""))} />
                <strong>
                  {p.label} {p.id === RECOMMENDED && <span className="pill sage">Suggested</span>}{" "}
                  {saved?.set && (
                    <span className="pill sky">
                      <CheckCircle2 size={11} /> Set
                    </span>
                  )}
                </strong>
                <small>{PROVIDER_USES[p.id]}</small>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

function KeyInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <input
      className="input"
      type="password"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      autoComplete="off"
      spellCheck={false}
      aria-label="API key"
    />
  );
}
