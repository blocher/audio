import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ChevronDown, ExternalLink } from "lucide-react";
import { useState } from "react";
import { api } from "../api";
import { PROVIDER_USES } from "../providers";
import type { SettingsData } from "../types";
import { Button, Note, errorText, useToast } from "./ui";

const RECOMMENDED = "openai";

/**
 * The gentle way to add an AI key: one recommended provider with click-by-click steps, others tucked away. Used by the
 * welcome wizard; Settings has the full list.
 */
export function AiQuickSetup({ onSaved }: { onSaved?: () => void }) {
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
                <a className="btn" href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer" style={{ alignSelf: "flex-start" }}>
                  <ExternalLink size={16} /> Open platform.openai.com
                </a>
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
                <strong>Paste it here</strong>
                <KeyInput value={key} onChange={setKey} placeholder="sk-…" />
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
