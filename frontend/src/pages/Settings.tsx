import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FolderInput, KeyRound, Link2, Mic, MonitorSmartphone, Plus, RefreshCw, Share, SlidersHorizontal, Sparkles, SquareStack, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { api } from "../api";
import { PACK_STRATEGIES } from "../components/CardPlanner";
import { OpenRouterConnect } from "../components/AiSetup";
import { AudibleSignInSteps } from "../components/AudibleConnect";
import { PeopleSection } from "../components/People";
import ModelPicker, { type ModelChoice } from "../components/ModelPicker";
import { BitratePicker } from "../components/Tools";
import { Button, Modal, Note, PageHead, SourceIcon, Spinner, errorText, useToast } from "../components/ui";
import { bytes, relative } from "../format";
import { useAction } from "../hooks/queries";
import { FEATURE_LABELS } from "../features";
import { PROVIDER_USES } from "../providers";
import { clearUserCaches, isIos, promptInstall, requestPersistence, storageInfo, usePwa } from "../pwa";
import { featureSet, useMe, useOnboarding } from "../hooks/session";
import { FEATURES, SOURCES, type AudibleAccount, type Feature, type SecretValue, type SettingsData, type YotoAccount } from "../types";
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
        <SetupSection />
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
        <AppSection />
      </div>
    </>
  );
}

/** What this person uses the app for (the rest is tucked away), and a way back into the welcome wizard. */
function SetupSection() {
  const qc = useQueryClient();
  const toast = useToast();
  const me = useMe();
  const status = useOnboarding();
  const chosen = featureSet(me?.features);
  const save = useAction((features: Feature[]) => api.patch("/onboarding", { features }), [["session"], ["onboarding"]]);
  const data = status.data;
  const missing = data
    ? [
        chosen.has("audible") && !data.audible.some((a) => a.connected) && "Audible",
        chosen.has("yoto") && !data.yoto.connected.length && "Yoto",
        chosen.has("ask") && !(data.ai.transcribe || data.ai.ask) && "an AI key for Ask",
      ].filter(Boolean)
    : [];

  function toggle(f: Feature) {
    const next = new Set(chosen);
    if (next.has(f)) next.delete(f);
    else next.add(f);
    if (!FEATURES.some((x) => next.has(x))) return toast("Keep at least one of Yoto cards, Ask or Listen", "error");
    save.mutate([...FEATURES, ...SOURCES].filter((x) => next.has(x)), {
      onSuccess: () => qc.invalidateQueries({ queryKey: ["session"] }),
      onError: (e) => toast(errorText(e), "error"),
    });
  }

  const group = (items: Feature[]) => (
    <div className="feature-toggles">
      {items.map((f) => (
        <label key={f} className={`feature-toggle ${chosen.has(f) ? "on" : ""}`}>
          <input type="checkbox" checked={chosen.has(f)} onChange={() => toggle(f)} />
          <span>
            <b>{FEATURE_LABELS[f].label}</b>
            <small>{FEATURE_LABELS[f].hint}</small>
          </span>
        </label>
      ))}
    </div>
  );

  return (
    <section className="panel" id="setup">
      <div className="panel-head">
        <Sparkles size={18} />
        <h3>Your setup</h3>
        <Link className="btn sm" to="/welcome">Run setup again</Link>
      </div>
      <div className="stack" style={{ "--gap": "14px" } as React.CSSProperties}>
        <div className="field">
          <span>What I use Audio for</span>
          {group(FEATURES)}
        </div>
        <div className="field">
          <span>Where my audio comes from</span>
          {group(SOURCES)}
          <small>Only these show in the menu. Turn something on here any time; nothing is deleted when it's off.</small>
        </div>
        {data && (
          <p className="muted" style={{ margin: 0 }}>
            Library: <b>{data.household_name}</b>
            {data.shared_with.length > 0 && <>, shared with {data.shared_with.join(", ")}</>}.
            {missing.length > 0 && <> Still to connect: {missing.join(", ")}.</>}
          </p>
        )}
      </div>
    </section>
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
        <Button size="sm" icon={<Plus size={15} />} onClick={() => setAdding(true)}>Add an Audible account</Button>
      </div>
      <p className="muted" style={{ marginBottom: 14 }}>
        A library can have as many Audible accounts as you like: yours, a partner's, a child's. All their books show up
        together (books shared through Amazon family sharing show once), and each person sees their own place in a book;
        mark which account is yours. Each signs in once as a new “device”, like the Audible app.
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
  return (
    <Modal title={`Sign in to Audible for ${account.name}`} onClose={onClose} footer={<Button variant="ghost" onClick={onClose}>Cancel</Button>}>
      <AudibleSignInSteps account={account} onConnected={onClose} />
    </Modal>
  );
}

function YotoSection({ data }: { data: SettingsData }) {
  const qc = useQueryClient();
  const me = useMe();
  const connect = useConnectYoto();
  const accounts = useQuery({ queryKey: ["yoto-accounts"], queryFn: () => api.get<YotoAccount[]>("/yoto/accounts") });
  const remove = useAction((id: number) => api.del(`/yoto/accounts/${id}`), [["yoto-accounts"], ["onboarding"]]);
  const ready = data.capabilities.yoto_ready;
  const connected = (accounts.data ?? []).filter((a) => a.connected);
  return (
    <section className="panel" id="yoto">
      <div className="panel-head">
        <SquareStack size={20} />
        <h3>Yoto</h3>
        {ready && (
          <Button size="sm" variant={connected.length ? undefined : "primary"} icon={<Link2 size={15} />} onClick={connect}>
            {connected.length ? "Connect another" : "Connect your Yoto account"}
          </Button>
        )}
      </div>
      <p className="muted" style={{ marginBottom: 14 }}>
        {ready
          ? "Sign in with Yoto once, and cards you make here go straight to your Yoto app."
          : me?.is_admin
            ? "Set up the Yoto app below once; then everyone can connect their own Yoto account with one button."
            : "Yoto isn't switched on for this site yet. Ask a super admin to set it up."}
      </p>
      {connected.length > 0 && (
        <div className="list" style={{ marginBottom: 16 }}>
          {connected.map((a) => (
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
      {me?.is_admin && (ready ? (
        <details className="admin-details">
          <summary>Yoto developer app (super admins)</summary>
          <YotoAppSettings data={data} />
        </details>
      ) : (
        <YotoAppSettings data={data} />
      ))}
    </section>
  );
}

/** The developer app every household signs in through. Set up once, by a super admin. */
function YotoAppSettings({ data }: { data: SettingsData }) {
  const toast = useToast();
  const [clientId, setClientId] = useState(data.yoto.client_id ?? "");
  const [secret, setSecret] = useState("");
  const save = useAction(() => api.put("/settings", { service: "yoto", values: { client_id: clientId, client_secret: secret } }), [["settings"], ["onboarding"]]);
  return (
    <div className="grid-2" style={{ marginTop: 12 }}>
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
            <span>Paste the client ID and secret here. Everyone on this site signs in to Yoto through this one app.</span>
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
        </div>
      </div>
    </div>
  );
}

function SecretField({ label, saved, value, onChange }: { label: string; saved: SecretValue; value: string; onChange: (v: string) => void }) {
  const placeholder = !saved.set
    ? "Not set"
    : saved.source === "shared"
      ? "Shared with you (hidden)"
      : saved.source === "server"
        ? "Set on the server"
        : `${saved.masked} (saved)`;
  return (
    <label className="field">
      <span>{label}</span>
      <input className="input" type="password" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} autoComplete="off" />
    </label>
  );
}

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
        <b>Only needed for Transcribe and Ask.</b> Yoto cards, listening and everything else work without a key. Add a key for any
        provider you use; its current models then appear in the transcription and Ask pickers. Keys are stored encrypted.
        {data.providers.some((p) => data[p.id].api_key.source === "shared") && " Some keys are shared with you by another library; a key you add here is used instead."}
      </p>
      <div className="grid-2">
        {data.providers.map((p) => {
          const saved = data[p.id].api_key;
          return (
            <div key={p.id} className="stack" style={{ "--gap": "6px" } as React.CSSProperties}>
              {p.id === "openrouter" && !saved.set ? (
                // OpenRouter hands over a key when you sign in; no copying.
                <div className="field">
                  <span>{p.label}</span>
                  <OpenRouterConnect compact />
                </div>
              ) : (
                <SecretField label={`${p.label} key`} saved={saved} value={keys[p.id] ?? ""} onChange={(v) => setKeys((k) => ({ ...k, [p.id]: v }))} />
              )}
              <div className="row" style={{ fontSize: "var(--text-xs)" }}>
                <span className="muted">{PROVIDER_USES[p.id]}</span>
                <span className="spacer" />
                {p.id !== "openrouter" && (
                  <a href={p.key_url} target="_blank" rel="noreferrer" style={{ color: "var(--terracotta)" }}>
                    Get a key
                  </a>
                )}
                {saved.source === "own" && (
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

function AppSection() {
  const pwa = usePwa();
  const toast = useToast();
  const device = useQuery({ queryKey: ["device-storage"], queryFn: storageInfo, staleTime: 0 });
  const ios = isIos();

  async function install() {
    if (await promptInstall()) toast("Audio is installed. Open it from your home screen, dock, or app launcher.");
  }
  async function keep() {
    const granted = await requestPersistence();
    toast(granted ? "This device will keep Audio’s saved data." : "The browser decided it may still clear saved data when space runs low.", granted ? "info" : "error");
    device.refetch();
  }
  async function clear() {
    await clearUserCaches();
    toast("Cleared saved library data and covers on this device.");
    device.refetch();
  }

  return (
    <section className="panel" id="app">
      <div className="panel-head">
        <MonitorSmartphone size={18} />
        <h3>App on this device</h3>
      </div>
      {pwa.standalone ? (
        <p className="muted" style={{ marginBottom: 14 }}>
          You’re using the installed app. Lock-screen and headphone controls work while audio plays, and pages you’ve opened stay
          readable offline.
        </p>
      ) : pwa.canInstall ? (
        <>
          <p className="muted" style={{ marginBottom: 14 }}>
            Install Audio to get its own window and icon, lock-screen playback controls, and offline access to pages you’ve opened.
          </p>
          <Button variant="primary" icon={<Download size={16} />} onClick={install}>
            Install Audio
          </Button>
        </>
      ) : ios ? (
        <p className="muted" style={{ marginBottom: 14 }}>
          To install on iPhone or iPad, open this page in Safari, tap <Share size={14} style={{ verticalAlign: "-2px" }} /> Share, then{" "}
          <strong>Add to Home Screen</strong>.
        </p>
      ) : (
        <p className="muted" style={{ marginBottom: 14 }}>
          To install, use your browser’s <strong>Install</strong> or <strong>Add to Home screen</strong> option (in Chrome and Edge it’s
          in the address bar or the ⋮ menu; in Safari on a Mac, choose File → Add to Dock).
        </p>
      )}
      {device.data && (
        <>
          <div className="divider" />
          <dl className="kv" style={{ marginBottom: 14 }}>
            <dt>Saved on this device</dt>
            <dd>
              {bytes(device.data.usage)}
              {device.data.quota ? ` of ${bytes(device.data.quota)} available` : ""}
            </dd>
            <dt>Kept when space is low</dt>
            <dd>{device.data.persisted ? "Yes" : "Not guaranteed"}</dd>
          </dl>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            {!device.data.persisted && (
              <Button size="sm" onClick={keep}>
                Keep saved data
              </Button>
            )}
            <Button size="sm" variant="ghost" icon={<Trash2 size={15} />} onClick={clear}>
              Clear saved data
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
