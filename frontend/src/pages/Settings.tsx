import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, FolderInput, KeyRound, Link2, Mic, Plus, RefreshCw, SlidersHorizontal, SquareStack, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { api } from "../api";
import { PACK_STRATEGIES } from "../components/CardPlanner";
import { PeopleSection } from "../components/People";
import ModelPicker, { type ModelChoice } from "../components/ModelPicker";
import { BitratePicker } from "../components/Tools";
import { Button, Modal, Note, PageHead, SourceIcon, Spinner, errorText, useToast } from "../components/ui";
import { bytes, relative } from "../format";
import { useAction } from "../hooks/queries";
import type { AudibleAccount, SettingsData, YotoAccount } from "../types";
import { useConnectYoto } from "./Yoto";

export default function Settings() {
  const location = useLocation();
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api.get<SettingsData>("/settings") });
  useEffect(() => {
    if (location.hash) document.querySelector(location.hash)?.scrollIntoView({ behavior: "smooth" });
  }, [location.hash, settings.data]);
  if (settings.isLoading || !settings.data) return <Spinner />;
  return (
    <>
      <PageHead eyebrow="Settings" title="Sources & preferences" lede="Accounts, keys, and how audio gets sized for Yoto." />
      <div className="stack" style={{ "--gap": "22px" } as React.CSSProperties}>
        <AudibleSection />
        <PeopleSection />
        <div className="grid-2" id="sources">
          <section className="panel">
            <div className="panel-head">
              <Mic size={18} />
              <h3>Podcasts</h3>
            </div>
            <p className="muted" style={{ marginBottom: 14 }}>Follow shows by Apple Podcasts link or RSS feed.</p>
            <Link className="btn" to="/podcasts">Add a podcast</Link>
          </section>
          <section className="panel">
            <div className="panel-head">
              <FolderInput size={18} />
              <h3>Local folders</h3>
            </div>
            <p className="muted" style={{ marginBottom: 14 }}>Upload folders of audio from this computer.</p>
            <Link className="btn" to="/folders">Import a folder</Link>
          </section>
        </div>
        <YotoSection data={settings.data} />
        <KeysSection data={settings.data} />
        <PreferencesSection data={settings.data} />
        <StorageSection />
      </div>
    </>
  );
}

function AudibleSection() {
  const qc = useQueryClient();
  const toast = useToast();
  const accounts = useQuery({ queryKey: ["audible-accounts"], queryFn: () => api.get<AudibleAccount[]>("/audible/accounts") });
  const locales = useQuery({ queryKey: ["locales"], queryFn: () => api.get<{ code: string; name: string }[]>("/audible/locales"), staleTime: Infinity });
  const [adding, setAdding] = useState(false);
  const [connecting, setConnecting] = useState<AudibleAccount | null>(null);
  const [name, setName] = useState("");
  const [locale, setLocale] = useState("us");
  const sync = useAction((id: number) => api.post(`/audible/accounts/${id}/sync`), [["audible-accounts"]]);
  const remove = useAction((id: number) => api.del(`/audible/accounts/${id}`), [["audible-accounts"], ["books"]]);
  const makeMine = useAction((id: number) => api.post(`/audible/accounts/${id}/mine`), [["audible-accounts"], ["books"], ["people"]]);

  async function create() {
    try {
      const account = await api.post<AudibleAccount>("/audible/accounts", { name, locale });
      qc.invalidateQueries({ queryKey: ["audible-accounts"] });
      setAdding(false);
      setName("");
      setConnecting(account);
    } catch (e) {
      toast(errorText(e), "error");
    }
  }

  return (
    <section className="panel" id="audible">
      <div className="panel-head">
        <SourceIcon kind="audible" size={22} />
        <h3>Audible accounts</h3>
        <Button size="sm" icon={<Plus size={15} />} onClick={() => setAdding(true)}>Add account</Button>
      </div>
      <p className="muted" style={{ marginBottom: 14 }}>
        Each account signs in once as a new “device”, like the Audible app. Add one for each person whose library you want;
        books you share through family sharing show up once. Mark which account is yours, and you'll see your own listening
        position, and Ask will use it.
      </p>
      {accounts.data?.length ? (
        <div className="list">
          {accounts.data.map((a) => (
            <div key={a.id} className="list-row">
              <span className="avatar">{a.name.slice(0, 1).toUpperCase()}</span>
              <div style={{ minWidth: 0 }}>
                <div className="title">
                  {a.name} {a.is_mine && <span className="pill sage">Yours</span>}
                </div>
                <div className="sub">
                  {a.connected ? <span className="pill sage">Connected</span> : <span className="pill honey">Not signed in</span>}
                  <span>{a.locale.toUpperCase()}</span>
                  {a.email && <span>{a.email}</span>}
                  <span>{a.book_count} titles</span>
                  <span>synced {relative(a.last_synced_at)}</span>
                </div>
                {a.last_error && <div className="sub" style={{ color: "var(--berry)" }}>{a.last_error.slice(0, 160)}</div>}
              </div>
              <div className="actions">
                {!a.is_mine && accounts.data!.length > 1 && (
                  <Button size="sm" variant="ghost" onClick={() => makeMine.mutate(a.id, { onSuccess: () => toast(`Showing ${a.name}'s listening positions to you`) })}>
                    This is me
                  </Button>
                )}
                {a.connected ? (
                  <Button size="sm" icon={<RefreshCw size={14} />} onClick={() => sync.mutate(a.id, { onSuccess: () => toast(`Syncing ${a.name}'s library`) })}>Sync</Button>
                ) : (
                  <Button size="sm" variant="primary" onClick={() => setConnecting(a)}>Sign in</Button>
                )}
                <Button
                  size="sm"
                  variant="danger"
                  iconOnly
                  icon={<Trash2 size={14} />}
                  aria-label="Remove"
                  onClick={() => confirm(`Remove ${a.name}'s Audible account? Converted audio for books only they have is deleted too.`) && remove.mutate(a.id)}
                />
              </div>
            </div>
          ))}
        </div>
      ) : (
        !accounts.isLoading && <Note tone="info">No Audible accounts yet. Add yours, then your partner's, to browse both libraries together.</Note>
      )}

      {adding && (
        <Modal
          title="Add an Audible account"
          onClose={() => setAdding(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
              <Button variant="primary" disabled={!name.trim()} onClick={create}>Continue</Button>
            </>
          }
        >
          <div className="stack" style={{ "--gap": "14px" } as React.CSSProperties}>
            <label className="field">
              <span>Whose library is this?</span>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ben" autoFocus />
            </label>
            <label className="field">
              <span>Audible store</span>
              <select className="select" value={locale} onChange={(e) => setLocale(e.target.value)}>
                {(locales.data ?? []).map((l) => (
                  <option key={l.code} value={l.code}>{l.name}</option>
                ))}
              </select>
            </label>
          </div>
        </Modal>
      )}
      {connecting && <AudibleSignIn account={connecting} onClose={() => setConnecting(null)} />}
    </section>
  );
}

function AudibleSignIn({ account, onClose }: { account: AudibleAccount; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [loginUrl, setLoginUrl] = useState("");
  const [pasted, setPasted] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .post<{ login_url: string }>(`/audible/accounts/${account.id}/login/start`)
      .then((r) => setLoginUrl(r.login_url))
      .catch((e) => setError(errorText(e)));
  }, [account.id]);

  async function finish() {
    setBusy(true);
    setError("");
    try {
      await api.post(`/audible/accounts/${account.id}/login/finish`, { redirect_url: pasted });
      qc.invalidateQueries({ queryKey: ["audible-accounts"] });
      qc.invalidateQueries({ queryKey: ["jobs"] });
      toast(`${account.name}'s Audible is connected — importing the library now`);
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Sign in to Audible for ${account.name}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!pasted.includes("maplanding")} loading={busy} onClick={finish}>Finish sign-in</Button>
        </>
      }
    >
      <ol className="steps">
        <li>
          <div className="stack" style={{ "--gap": "8px" } as React.CSSProperties}>
            <strong>Open Amazon's sign-in page</strong>
            <span className="muted" style={{ fontSize: "var(--text-sm)" }}>Sign in with {account.name}'s Amazon/Audible account. You may be asked for a code or a captcha, sometimes twice.</span>
            {loginUrl ? (
              <a className="btn primary" href={loginUrl} target="_blank" rel="noreferrer" style={{ alignSelf: "flex-start" }}>
                <ExternalLink size={16} /> Open Amazon sign-in
              </a>
            ) : (
              <Spinner />
            )}
          </div>
        </li>
        <li>
          <div className="stack" style={{ "--gap": "8px" } as React.CSSProperties}>
            <strong>Copy the address of the page you land on</strong>
            <span className="muted" style={{ fontSize: "var(--text-sm)" }}>
              After signing in, Amazon shows an error or blank page — that's expected. Copy the whole URL from the address bar; it contains <code>maplanding</code>.
            </span>
          </div>
        </li>
        <li>
          <div className="stack" style={{ "--gap": "8px" } as React.CSSProperties}>
            <strong>Paste it here</strong>
            <textarea className="textarea" value={pasted} onChange={(e) => setPasted(e.target.value.trim())} placeholder="https://www.amazon.com/ap/maplanding?…openid.oa2.authorization_code=…" />
          </div>
        </li>
      </ol>
      {error && <div style={{ marginTop: 14 }}><Note tone="error">{error}</Note></div>}
    </Modal>
  );
}

function YotoSection({ data }: { data: SettingsData }) {
  const qc = useQueryClient();
  const toast = useToast();
  const connect = useConnectYoto();
  const accounts = useQuery({ queryKey: ["yoto-accounts"], queryFn: () => api.get<YotoAccount[]>("/yoto/accounts") });
  const [clientId, setClientId] = useState(data.yoto.client_id ?? "");
  const [secret, setSecret] = useState("");
  const save = useAction(() => api.put("/settings", { service: "yoto", values: { client_id: clientId, client_secret: secret } }), [["settings"]]);
  const remove = useAction((id: number) => api.del(`/yoto/accounts/${id}`), [["yoto-accounts"]]);
  return (
    <section className="panel" id="yoto">
      <div className="panel-head">
        <SquareStack size={20} />
        <h3>Yoto</h3>
      </div>
      <div className="grid-2">
        <div className="stack" style={{ "--gap": "12px" } as React.CSSProperties}>
          <ol className="steps" style={{ fontSize: "var(--text-sm)" }}>
            <li>
              <span>
                Create a <b>confidential</b> app at{" "}
                <a href="https://dashboard.yoto.dev/" target="_blank" rel="noreferrer" style={{ color: "var(--terracotta)" }}>dashboard.yoto.dev</a>.
              </span>
            </li>
            <li>
              <span>
                Add this callback URL: <code>{data.capabilities.yoto_redirect_uri}</code>
              </span>
            </li>
            <li>
              <span>
                Tick these scopes on the app: {data.capabilities.yoto_scopes.map((sc, i) => (
                  <span key={sc}>{i > 0 && ", "}<code>{sc}</code></span>
                ))}
              </span>
            </li>
            <li>
              <span>Paste the client ID and secret here, then connect your account.</span>
            </li>
          </ol>
        </div>
        <div className="stack" style={{ "--gap": "12px" } as React.CSSProperties}>
          <label className="field">
            <span>Client ID</span>
            <input className="input" value={clientId} onChange={(e) => setClientId(e.target.value)} />
          </label>
          <label className="field">
            <span>Client secret</span>
            <input className="input" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={data.yoto.client_secret.set ? data.yoto.client_secret.masked : ""} />
          </label>
          <div className="row">
            <Button onClick={() => save.mutate(undefined, { onSuccess: () => (setSecret(""), toast("Saved")) })} loading={save.isPending}>Save</Button>
            <Button variant="sage" icon={<Link2 size={16} />} disabled={!data.yoto.client_id} onClick={connect}>Connect a Yoto account</Button>
          </div>
        </div>
      </div>
      {(accounts.data ?? []).filter((a) => a.connected).length > 0 && (
        <div className="list" style={{ marginTop: 16 }}>
          {accounts.data!.filter((a) => a.connected).map((a) => (
            <div key={a.id} className="list-row">
              <SquareStack size={18} />
              <div>
                <div className="title">{a.email || a.name}</div>
                <div className="sub">
                  <span className="pill sage">Connected</span>
                  <span>{a.playlist_count} playlists</span>
                  {a.last_error && <span style={{ color: "var(--berry)" }}>{a.last_error}</span>}
                </div>
              </div>
              <Button size="sm" variant="danger" onClick={() => confirm("Disconnect this Yoto account?") && remove.mutate(a.id, { onSuccess: () => qc.invalidateQueries({ queryKey: ["playlists"] }) })}>
                Disconnect
              </Button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function SecretField({ label, set, masked, value, onChange }: { label: string; set: boolean; masked: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input className="input" type="password" value={value} onChange={(e) => onChange(e.target.value)} placeholder={set ? `${masked} (saved)` : "Not set"} autoComplete="off" />
    </label>
  );
}

const PROVIDER_USES: Record<string, string> = {
  anthropic: "Ask",
  openai: "Transcription & Ask",
  gemini: "Transcription & Ask",
  xai: "Ask",
  groq: "Transcription & Ask · cheapest Whisper",
};

function KeysSection({ data }: { data: SettingsData }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [stt, setStt] = useState<ModelChoice | null>(
    data.preferences.stt_provider ? { provider: data.preferences.stt_provider, model: data.preferences.stt_model } : null,
  );
  const [chat, setChat] = useState<ModelChoice | null>(
    data.preferences.chat_provider ? { provider: data.preferences.chat_provider, model: data.preferences.chat_model } : null,
  );
  const [groqBudget, setGroqBudget] = useState(data.preferences.groq_context_tokens);
  const anyKey = data.providers.some((p) => data[p.id].api_key.set);

  const saveKeys = useAction(async () => {
    for (const [service, key] of Object.entries(keys)) if (key.trim()) await api.put("/settings", { service, values: { api_key: key.trim() } });
  }, [["settings"], ["ai-models"]]);
  const saveDefaults = useAction(
    () =>
      api.put("/settings", {
        service: "preferences",
        values: {
          stt_provider: stt?.provider ?? "",
          stt_model: stt?.model ?? "",
          chat_provider: chat?.provider ?? "",
          chat_model: chat?.model ?? "",
          groq_context_tokens: groqBudget,
        },
      }),
    [["settings"], ["ai-models"]],
  );
  const refresh = useAction(() => api.get("/ai/models?kind=chat&refresh=true"), [["ai-models"]]);
  const removeKey = useAction((service: string) => api.put("/settings", { service, values: { api_key: null } }), [["settings"], ["ai-models"]]);

  return (
    <section className="panel" id="ai">
      <div className="panel-head">
        <KeyRound size={18} />
        <h3>AI providers</h3>
        {anyKey && (
          <Button size="sm" variant="ghost" icon={<RefreshCw size={14} />} loading={refresh.isPending} onClick={() => refresh.mutate(undefined, { onSuccess: () => toast("Model lists refreshed") })}>
            Refresh model lists
          </Button>
        )}
      </div>
      <p className="muted" style={{ marginBottom: 14 }}>
        Add a key for any provider you use; its current models then appear in the transcription and Ask pickers. Keys are stored encrypted.
      </p>
      <div className="grid-2">
        {data.providers.map((p) => {
          const saved = data[p.id].api_key;
          return (
            <div key={p.id} className="stack" style={{ "--gap": "6px" } as React.CSSProperties}>
              <SecretField label={`${p.label} key`} set={saved.set} masked={saved.masked} value={keys[p.id] ?? ""} onChange={(v) => setKeys((k) => ({ ...k, [p.id]: v }))} />
              <div className="row" style={{ fontSize: "var(--text-xs)" }}>
                <span className="muted">{PROVIDER_USES[p.id]}</span>
                <span className="spacer" />
                <a href={p.key_url} target="_blank" rel="noreferrer" style={{ color: "var(--terracotta)" }}>
                  Get a key
                </a>
                {saved.set && (
                  <button className="btn ghost sm" style={{ height: 22, padding: "0 6px" }} onClick={() => confirm(`Remove the ${p.label} key?`) && removeKey.mutate(p.id)}>
                    Remove
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="row" style={{ marginTop: 16 }}>
        <span className="spacer" />
        <Button
          variant="primary"
          disabled={!Object.values(keys).some((k) => k.trim())}
          loading={saveKeys.isPending}
          onClick={() =>
            saveKeys.mutate(undefined, {
              onSuccess: () => {
                setKeys({});
                qc.invalidateQueries({ queryKey: ["ai-models"] });
                toast("Keys saved");
              },
              onError: (e) => toast(errorText(e), "error"),
            })
          }
        >
          Save keys
        </Button>
      </div>

      {anyKey && (
        <>
          <div className="divider" />
          <div className="grid-2">
            <label className="field">
              <span>Default transcription model</span>
              <ModelPicker kind="stt" value={stt} onChange={setStt} />
              <small>You can still pick another each time you transcribe.</small>
            </label>
            <label className="field">
              <span>Default model for “Ask”</span>
              <ModelPicker kind="chat" value={chat} onChange={setChat} />
              <small>The chat also has its own picker; it remembers your last choice.</small>
            </label>
            {data.groq.api_key.set && (
              <label className="field">
                <span>Groq transcript budget (tokens per question)</span>
                <input className="input" type="number" min={4000} max={500000} step={1000} value={groqBudget} onChange={(e) => setGroqBudget(Number(e.target.value))} />
                <small>Groq plans cap tokens per minute well below model context; raise this if your plan allows. Longer books are excerpted to fit.</small>
              </label>
            )}
          </div>
          <div className="row" style={{ marginTop: 14 }}>
            <span className="spacer" />
            <Button loading={saveDefaults.isPending} onClick={() => saveDefaults.mutate(undefined, { onSuccess: () => toast("Defaults saved") })}>
              Save defaults
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

function PreferencesSection({ data }: { data: SettingsData }) {
  const toast = useToast();
  const prefs = data.preferences;
  const [kbps, setKbps] = useState<number | null>(prefs.default_kbps);
  const [mono, setMono] = useState(prefs.default_mono);
  const [mb, setMb] = useState(prefs.card_limit_mb);
  const [hours, setHours] = useState(prefs.card_limit_hours);
  const [strategy, setStrategy] = useState(prefs.pack_strategy);
  const save = useAction(
    () => api.put("/settings", { service: "preferences", values: { default_kbps: kbps, default_mono: mono, card_limit_mb: mb, card_limit_hours: hours, pack_strategy: strategy } }),
    [["settings"], ["presets"]],
  );
  return (
    <section className="panel" id="preferences">
      <div className="panel-head">
        <SlidersHorizontal size={18} />
        <h3>Audio & cards</h3>
      </div>
      <div className="stack" style={{ "--gap": "18px" } as React.CSSProperties}>
        <div className="stack">
          <strong>Default MP3 quality for conversions and downsizing</strong>
          <BitratePicker kbps={kbps} mono={mono} onChange={(k, m) => (setKbps(k), setMono(m))} />
        </div>
        <div className="grid-2">
          <label className="field">
            <span>Card size limit (MB)</span>
            <input className="input" type="number" min={50} max={2000} value={mb} onChange={(e) => setMb(Number(e.target.value))} />
            <small>Yoto documents 500 MB per Make-Your-Own card.</small>
          </label>
          <label className="field">
            <span>Card length limit (hours)</span>
            <input className="input" type="number" min={0} max={24} step={0.5} value={hours} onChange={(e) => setHours(Number(e.target.value))} />
            <small>0 means no length limit. Yoto's docs say 5 hours, but in practice only size is enforced.</small>
          </label>
        </div>
        <div className="field">
          <span>Default packing</span>
          <div className="segmented" style={{ alignSelf: "flex-start" }}>
            {PACK_STRATEGIES.map((s) => (
              <button key={s.id} className={strategy === s.id ? "active" : ""} onClick={() => setStrategy(s.id)}>
                {s.label}
              </button>
            ))}
          </div>
          <small>{PACK_STRATEGIES.find((s) => s.id === strategy)?.hint} With several sources picked, cards default to back to back.</small>
        </div>
        <div className="row">
          <span className="spacer" />
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: () => toast("Preferences saved") })}>Save preferences</Button>
        </div>
      </div>
    </section>
  );
}

function StorageSection() {
  const storage = useQuery({
    queryKey: ["storage"],
    queryFn: () => api.get<{ disk_total: number; disk_free: number; tracks_original_bytes: number; tracks_optimized_bytes: number; track_count: number }>("/storage"),
  });
  const s = storage.data;
  if (!s) return null;
  return (
    <section className="panel">
      <h3>Storage</h3>
      <dl className="kv">
        <dt>Audio files</dt>
        <dd>{s.track_count} tracks · {bytes(s.tracks_original_bytes)} originals · {bytes(s.tracks_optimized_bytes)} downsized</dd>
        <dt>Disk</dt>
        <dd>{bytes(s.disk_free)} free of {bytes(s.disk_total)}</dd>
      </dl>
    </section>
  );
}
