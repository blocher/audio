import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  AudioLines,
  BookOpen,
  CheckCircle2,
  Circle,
  FolderOpen,
  Headphones,
  LibraryBig,
  MessageCircle,
  Mic,
  PartyPopper,
  Plus,
  Search,
  SquareStack,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { connectInPopup } from "../connect";
import { AiQuickSetup } from "../components/AiSetup";
import { AudibleSignInSteps } from "../components/AudibleConnect";
import { Button, Note, SourceIcon, Spinner, errorText } from "../components/ui";
import { featureSet, useOnboarding } from "../hooks/session";
import { FEATURE_LABELS } from "../features";
import { FEATURES, SOURCES, type AudibleAccount, type Feature, type Onboarding } from "../types";

type Step = "start" | "audible" | "podcasts" | "yoto" | "ai" | "done";

const STEP_LABELS: Record<Step, string> = {
  start: "Welcome",
  audible: "Audible",
  podcasts: "Podcasts",
  yoto: "Yoto",
  ai: "Ask",
  done: "Done",
};

/** Only the steps the chosen features need: Audible and Podcasts for those sources, Yoto for cards, AI for Ask. */
function stepsFor(features: Feature[], requested: Step | null): Step[] {
  const has = featureSet(features);
  const steps: Step[] = ["start"];
  if (has.has("audible")) steps.push("audible");
  if (has.has("podcasts")) steps.push("podcasts");
  if (has.has("yoto")) steps.push("yoto");
  if (has.has("ask")) steps.push("ai");
  // A step opened directly (e.g. "Set up Ask" from a book) still shows, even if it wasn't picked.
  if (requested && !steps.includes(requested) && requested !== "done") steps.push(requested);
  return [...steps, "done"];
}

/**
 * The first thing someone new sees: a few big, skippable steps to connect Audible, Yoto and (only if they want Ask)
 * an AI key. It can be opened again from Settings, or straight at one step with ?step=ai.
 */
export default function Welcome() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const status = useOnboarding();
  const requested = (params.get("step") as Step | null) ?? null;
  const steps = stepsFor(status.data?.features ?? [], requested && requested in STEP_LABELS ? requested : null);
  const step: Step = requested && steps.includes(requested) ? requested : "start";
  const index = steps.indexOf(step);

  function go(next: Step) {
    setParams({ step: next });
    window.scrollTo({ top: 0 });
  }
  // After the first step the list can change (it depends on what was picked), so "next" reads it fresh.
  const nextAfter = (from: Step, features: Feature[]) => {
    const list = stepsFor(features, null);
    return list[Math.min(list.indexOf(from) + 1, list.length - 1)] ?? "done";
  };
  const next = () => go(steps[Math.min(index + 1, steps.length - 1)]);
  const back = () => go(steps[Math.max(index - 1, 0)]);

  async function finish(to = "/") {
    await api.patch("/onboarding", { done: true });
    await qc.invalidateQueries({ queryKey: ["session"] });
    navigate(to);
  }

  // Reaching the last step counts as finishing, so a refresh or the back button doesn't bring the wizard back.
  useEffect(() => {
    if (step === "done" && status.data && !status.data.onboarded) {
      void api.patch("/onboarding", { done: true }).then(() => {
        qc.invalidateQueries({ queryKey: ["session"] });
        qc.invalidateQueries({ queryKey: ["onboarding"] });
      });
    }
  }, [step, status.data, qc]);

  const data = status.data;

  return (
    <div className="welcome">
      <header className="welcome-top">
        <div className="brand" style={{ padding: 0 }}>
          <AudioLines size={24} /> Audio
        </div>
        <ol className="welcome-progress" aria-label="Setup steps">
          {steps.map((s, n) => (
            <li key={s} className={n < index ? "done" : n === index ? "current" : ""} aria-current={n === index ? "step" : undefined}>
              <span className="dot" />
              <span className="label">{STEP_LABELS[s]}</span>
            </li>
          ))}
        </ol>
        {step !== "done" && (
          <button type="button" className="link-btn" onClick={() => void finish()}>
            {data?.onboarded ? "Close" : "Skip setup for now"}
          </button>
        )}
      </header>

      <main className="welcome-card">
        {!data ? (
          <Spinner size={26} />
        ) : step === "start" ? (
          <StartStep data={data} onNext={(features) => go(nextAfter("start", features))} />
        ) : step === "audible" ? (
          <AudibleStep data={data} onNext={next} onBack={back} />
        ) : step === "podcasts" ? (
          <PodcastsStep onNext={next} onBack={back} />
        ) : step === "yoto" ? (
          <YotoStep data={data} onNext={next} onBack={back} />
        ) : step === "ai" ? (
          <AiStep data={data} onNext={next} onBack={back} />
        ) : (
          <DoneStep data={data} onFinish={finish} />
        )}
      </main>
    </div>
  );
}

function StepNav({ onBack, onNext, nextLabel = "Continue", skipLabel, onSkip, nextVariant = "primary" }: {
  onBack?: () => void;
  onNext?: () => void;
  nextLabel?: string;
  skipLabel?: string;
  onSkip?: () => void;
  nextVariant?: "primary" | "ghost";
}) {
  return (
    <div className="welcome-nav">
      {onBack && (
        <Button variant="ghost" icon={<ArrowLeft size={16} />} onClick={onBack}>
          Back
        </Button>
      )}
      <span className="spacer" />
      {skipLabel && onSkip && (
        <Button variant="ghost" onClick={onSkip}>
          {skipLabel}
        </Button>
      )}
      {onNext && (
        <Button variant={nextVariant} size="lg" onClick={onNext}>
          {nextLabel} <ArrowRight size={17} />
        </Button>
      )}
    </div>
  );
}

function Done({ children }: { children: ReactNode }) {
  return (
    <div className="welcome-done">
      <CheckCircle2 size={22} /> <span>{children}</span>
    </div>
  );
}

// ---------- 1. what it's for ----------

const FEATURE_ICONS: Record<Feature, ReactNode> = {
  yoto: <SquareStack size={26} />,
  ask: <MessageCircle size={26} />,
  listen: <Headphones size={26} />,
  audible: <SourceIcon kind="audible" size={22} />,
  podcasts: <Mic size={22} />,
  folders: <FolderOpen size={22} />,
};

function StartStep({ data, onNext }: { data: Onboarding; onNext: (features: Feature[]) => void }) {
  const qc = useQueryClient();
  // Someone new starts with the most common picks; someone rerunning setup sees what they chose before.
  const [picked, setPicked] = useState<Set<Feature>>(
    new Set(data.features.length ? data.features : ["yoto", "listen", "audible", "podcasts", "folders"]),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const anyFeature = FEATURES.some((f) => picked.has(f));

  const toggle = (f: Feature) =>
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      return next;
    });

  async function save() {
    setBusy(true);
    setError("");
    const features = [...FEATURES, ...SOURCES].filter((f) => picked.has(f));
    try {
      await api.patch("/onboarding", { features });
      await qc.invalidateQueries({ queryKey: ["onboarding"] });
      qc.invalidateQueries({ queryKey: ["session"] });
      onNext(features);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const tile = (f: Feature) => (
    <button key={f} type="button" className={`use-choice ${picked.has(f) ? "picked" : ""}`} aria-pressed={picked.has(f)} onClick={() => toggle(f)}>
      <span className="use-check">{picked.has(f) ? <CheckCircle2 size={20} /> : <Circle size={20} />}</span>
      <span className="use-icon">{FEATURE_ICONS[f]}</span>
      <strong>{FEATURE_LABELS[f].label}</strong>
      <span>{FEATURE_TEXT[f]}</span>
    </button>
  );

  return (
    <>
      <h1>Hi {data.name}! Let's get you set up.</h1>
      <p className="welcome-lede">
        Pick what you'd like, and we'll only ask about those. It takes a few minutes, and you can change it any time.
        {data.shared_with.length > 0 && (
          <> You're sharing <b>{data.household_name}</b> with {listNames(data.shared_with)}.</>
        )}
      </p>
      <h2>What would you like to do?</h2>
      <div className="use-choices">{FEATURES.map(tile)}</div>
      <h2>Where does your audio come from?</h2>
      <div className="use-choices compact">{SOURCES.map(tile)}</div>
      {error && <div style={{ marginTop: 14, width: "100%" }}><Note tone="error">{error}</Note></div>}
      <div className="welcome-nav">
        <span className="muted" style={{ fontSize: "var(--text-sm)" }}>{!anyFeature && "Pick at least one thing to do."}</span>
        <span className="spacer" />
        <Button variant="primary" size="lg" loading={busy} disabled={!anyFeature} onClick={() => void save()}>
          Continue <ArrowRight size={17} />
        </Button>
      </div>
    </>
  );
}

const FEATURE_TEXT: Record<Feature, string> = {
  yoto: "Put audiobooks and podcasts onto Make Your Own cards for a Yoto player.",
  ask: "Ask questions about the book you're listening to, with no spoilers past where you are.",
  listen: "Play your audiobooks and podcasts right here, on your phone or computer.",
  audible: "Audiobooks you've bought on Audible.",
  podcasts: "Shows you follow, from Apple Podcasts or any feed.",
  folders: "Audio files on your computer, like CDs you've copied.",
};

// ---------- 2. Audible ----------

/**
 * Connect one or more Audible accounts. A library can hold several (yours, a partner's, a child's); books shared
 * through Amazon family sharing show up once, and each person sees their own listening position.
 */
function AudibleStep({ data, onNext, onBack }: { data: Onboarding; onNext: () => void; onBack: () => void }) {
  const qc = useQueryClient();
  const accounts = useQuery({ queryKey: ["audible-accounts"], queryFn: () => api.get<AudibleAccount[]>("/audible/accounts") });
  const locales = useQuery({ queryKey: ["locales"], queryFn: () => api.get<{ code: string; name: string }[]>("/audible/locales"), staleTime: Infinity });
  const connected = (accounts.data ?? []).filter((a) => a.connected);
  const unfinished = (accounts.data ?? []).filter((a) => !a.connected);
  const mineConnected = connected.some((a) => a.is_mine);
  const [adding, setAdding] = useState<boolean | null>(null);
  const showForm = adding ?? !connected.length;
  const [name, setName] = useState<string | null>(null);
  const [locale, setLocale] = useState("us");
  const [signingIn, setSigningIn] = useState<AudibleAccount | null>(null);
  const [error, setError] = useState("");
  // The first account is usually their own; after that it's someone else's.
  const whose = name ?? (mineConnected || connected.length ? "" : data.name);

  async function start() {
    setError("");
    try {
      const label = whose.trim() || data.name;
      const retry = unfinished.find((a) => a.name.toLowerCase() === label.toLowerCase() && a.locale === locale);
      const account = retry ?? (await api.post<AudibleAccount>("/audible/accounts", { name: label, locale }));
      qc.invalidateQueries({ queryKey: ["audible-accounts"] });
      setSigningIn(account);
    } catch (e) {
      setError(errorText(e));
    }
  }

  if (signingIn)
    return (
      <>
        <h1>Sign in to {signingIn.name === data.name ? "your" : `${signingIn.name}'s`} Audible</h1>
        <p className="welcome-lede">Three short steps. Amazon doesn't let other apps show its sign-in here, so it opens in a new tab.</p>
        <AudibleSignInSteps
          account={signingIn}
          onConnected={() => {
            setSigningIn(null);
            setAdding(false);
            setName(null);
            qc.invalidateQueries({ queryKey: ["onboarding"] });
          }}
        />
        <StepNav onBack={() => setSigningIn(null)} skipLabel="Skip Audible for now" onSkip={onNext} />
      </>
    );

  return (
    <>
      <span className="welcome-icon"><SourceIcon kind="audible" size={30} /></span>
      <h1>{connected.length ? "Your Audible accounts" : "Connect your Audible library"}</h1>
      <p className="welcome-lede">
        {connected.length
          ? "Add everyone in your home who buys on Audible: all their books appear together, and each person sees their own place in a book."
          : "So the audiobooks you own show up here. It signs in the same way the Audible app does on a new phone. You can add other people's Audible accounts too."}
      </p>
      {connected.length > 0 && (
        <div className="stack" style={{ "--gap": "8px", marginBottom: 18, width: "100%" } as React.CSSProperties}>
          {connected.map((a) => (
            <Done key={a.id}>
              {a.name}'s Audible is connected{a.book_count ? ` · ${a.book_count} titles` : " · loading books"}
            </Done>
          ))}
        </div>
      )}
      {showForm ? (
        <div className="stack welcome-form" style={{ "--gap": "14px" } as React.CSSProperties}>
          <div className="grid-2">
            <label className="field">
              <span>Whose Audible account?</span>
              <input className="input" value={whose} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sam" />
              <small>Just a label, so you can tell accounts apart.</small>
            </label>
            <label className="field">
              <span>Which Audible store?</span>
              <select className="select" value={locale} onChange={(e) => setLocale(e.target.value)}>
                {(locales.data ?? [{ code: "us", name: "United States" }]).map((l) => (
                  <option key={l.code} value={l.code}>{l.name}</option>
                ))}
              </select>
            </label>
          </div>
          {error && <Note tone="error">{error}</Note>}
          <div className="row" style={{ gap: 10 }}>
            <Button variant="primary" size="lg" disabled={!whose.trim()} onClick={() => void start()}>
              Connect {whose.trim() && whose.trim() !== data.name ? `${whose.trim()}'s` : "my"} Audible
            </Button>
            {connected.length > 0 && <Button variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>}
          </div>
        </div>
      ) : (
        <Button icon={<Plus size={16} />} onClick={() => setAdding(true)}>
          Add another Audible account
        </Button>
      )}
      <StepNav
        onBack={onBack}
        onNext={onNext}
        nextLabel={connected.length ? "Continue" : "Skip for now"}
        nextVariant={connected.length ? "primary" : "ghost"}
      />
    </>
  );
}

// ---------- 2b. Podcasts ----------

interface PodcastResult {
  title: string;
  author: string;
  feed_url: string;
  image_url: string;
}

function PodcastsStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const qc = useQueryClient();
  const following = useQuery({ queryKey: ["podcasts"], queryFn: () => api.get<{ id: number; title: string; feed_url: string }[]>("/podcasts") });
  const [term, setTerm] = useState("");
  const [query, setQuery] = useState("");
  const results = useQuery({
    queryKey: ["podcast-search", query],
    queryFn: () => api.get<PodcastResult[]>(`/podcasts/search?q=${encodeURIComponent(query)}`),
    enabled: query.length >= 2,
  });
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const followed = new Set((following.data ?? []).map((p) => p.feed_url));

  async function follow(result: PodcastResult) {
    setBusy(result.feed_url);
    setError("");
    try {
      await api.post("/podcasts", { url: result.feed_url });
      qc.invalidateQueries({ queryKey: ["podcasts"] });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  }

  return (
    <>
      <span className="welcome-icon"><Mic size={30} /></span>
      <h1>Follow a podcast or two</h1>
      <p className="welcome-lede">Search for a show and tap Follow. New episodes appear by themselves. You can add more later from Podcasts.</p>
      {(following.data ?? []).length > 0 && (
        <div className="stack" style={{ "--gap": "8px", marginBottom: 16, width: "100%" } as React.CSSProperties}>
          {following.data!.map((p) => (
            <Done key={p.id}>Following {p.title}</Done>
          ))}
        </div>
      )}
      <form
        className="row welcome-form"
        style={{ gap: 8 }}
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(term.trim());
        }}
      >
        <input className="input" style={{ flex: 1 }} value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Show name, e.g. Story Pirates" aria-label="Search podcasts" />
        <Button type="submit" icon={<Search size={16} />} loading={results.isFetching}>Search</Button>
      </form>
      {error && <div style={{ marginTop: 12, width: "100%" }}><Note tone="error">{error}</Note></div>}
      {results.data && (
        <div className="list welcome-form" style={{ marginTop: 14 }}>
          {results.data.length === 0 && <div className="list-row muted">No shows found. Try fewer words.</div>}
          {results.data.slice(0, 6).map((r) => (
            <div key={r.feed_url} className="list-row">
              <img src={r.image_url} alt="" width={44} height={44} style={{ borderRadius: 8, objectFit: "cover" }} />
              <div style={{ minWidth: 0 }}>
                <div className="title truncate">{r.title}</div>
                <div className="sub"><span className="truncate">{r.author}</span></div>
              </div>
              {followed.has(r.feed_url) ? (
                <span className="pill sage"><CheckCircle2 size={11} /> Following</span>
              ) : (
                <Button size="sm" variant="primary" loading={busy === r.feed_url} onClick={() => void follow(r)}>Follow</Button>
              )}
            </div>
          ))}
        </div>
      )}
      <StepNav
        onBack={onBack}
        onNext={onNext}
        nextLabel={(following.data ?? []).length ? "Continue" : "Skip for now"}
        nextVariant={(following.data ?? []).length ? "primary" : "ghost"}
      />
    </>
  );
}

// ---------- 3. Yoto ----------

function YotoStep({ data, onNext, onBack }: { data: Onboarding; onNext: () => void; onBack: () => void }) {
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const [error, setError] = useState(params.get("error") ?? "");
  const [busy, setBusy] = useState(false);
  const justConnected = params.get("connected") === "1";
  const connected = data.yoto.connected;
  const optional = !featureSet(data.features).has("yoto");

  useEffect(() => {
    if (justConnected) {
      qc.invalidateQueries({ queryKey: ["onboarding"] });
      qc.invalidateQueries({ queryKey: ["yoto-accounts"] });
    }
  }, [justConnected, qc]);

  async function connect() {
    setBusy(true);
    setError("");
    try {
      const { authorize_url } = await api.post<{ authorize_url: string }>("/yoto/accounts", {
        name: data.name,
        return_to: "/welcome?step=yoto",
        popup: true,
      });
      const result = await connectInPopup(authorize_url, "yoto");
      if (result.error) setError(result.error);
      qc.invalidateQueries({ queryKey: ["onboarding"] });
      qc.invalidateQueries({ queryKey: ["yoto-accounts"] });
    } catch (e) {
      if (!(e instanceof Error && e.message === "closed")) setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <span className="welcome-icon"><SquareStack size={30} /></span>
      <h1>{connected.length ? "Yoto is connected" : `Connect your Yoto account${optional ? " (optional)" : ""}`}</h1>
      <p className="welcome-lede">
        {connected.length
          ? "Cards you make here are sent straight to your Yoto app. Then link each one to a blank card in the Yoto app."
          : "This lets Audio send cards to your Yoto app. A small Yoto sign-in window opens; sign in there and it closes by itself."}
      </p>
      {connected.map((c) => (
        <Done key={c}>Connected to {c}</Done>
      ))}
      {!connected.length && data.yoto.ready && (
        <Button variant="primary" size="lg" loading={busy} onClick={() => void connect()} icon={<SquareStack size={18} />}>
          Sign in with Yoto
        </Button>
      )}
      {!connected.length && !data.yoto.ready && (
        <Note tone="info">Yoto isn't switched on for this site yet. Whoever invited you can turn it on in Settings; skip this for now.</Note>
      )}
      {error && <div style={{ marginTop: 14 }}><Note tone="error">{error}</Note></div>}
      <StepNav
        onBack={onBack}
        onNext={onNext}
        nextLabel={connected.length ? "Continue" : optional ? "Skip, I don't have a Yoto" : "Skip for now"}
        nextVariant={connected.length ? "primary" : "ghost"}
      />
    </>
  );
}

// ---------- 4. AI (optional) ----------

function AiStep({ data, onNext, onBack }: { data: Onboarding; onNext: () => void; onBack: () => void }) {
  const ready = data.ai.transcribe && data.ai.ask;
  const yotoOnly = !featureSet(data.features).has("ask");
  return (
    <>
      <span className="welcome-icon"><MessageCircle size={30} /></span>
      <span className="pill honey" style={{ marginBottom: 10 }}>Optional</span>
      <h1>{ready ? "Ask is ready to go" : "Want to ask questions about your books?"}</h1>
      <p className="welcome-lede">
        This step is <b>only needed for Transcribe and Ask</b>, which use an AI company's service to turn a book's audio into
        text and answer questions about it. {yotoOnly ? "For Yoto cards you don't need it, so you can skip this." : "Everything else works without it."}
      </p>
      {ready ? (
        <Done>{data.ai.borrowed ? "It's already set up for you. There's nothing to do here." : "Your AI key is saved."}</Done>
      ) : (
        <>
          {(data.ai.transcribe || data.ai.ask) && (
            <Note tone="info">{data.ai.ask ? "Asking works, but transcribing needs a key that can transcribe." : "Transcribing works, but asking needs a key that can answer questions."}</Note>
          )}
          {!yotoOnly ? (
            <AiQuickSetup onSaved={onNext} />
          ) : (
            <details className="welcome-details">
              <summary>Set it up anyway</summary>
              <AiQuickSetup onSaved={onNext} />
            </details>
          )}
        </>
      )}
      <StepNav
        onBack={onBack}
        onNext={onNext}
        nextLabel={ready ? "Continue" : "Skip this step"}
        nextVariant={ready || yotoOnly ? "primary" : "ghost"}
      />
    </>
  );
}

// ---------- 5. done ----------

function DoneStep({ data, onFinish }: { data: Onboarding; onFinish: (to?: string) => Promise<void> }) {
  const has = featureSet(data.features);
  const items: { ok: boolean; label: string; show: boolean }[] = [
    { ok: data.audible.some((a) => a.connected), label: "Audible", show: has.has("audible") },
    { ok: data.yoto.connected.length > 0, label: "Yoto account", show: has.has("yoto") },
    { ok: data.ai.transcribe || data.ai.ask, label: "Ask & Transcribe", show: has.has("ask") },
  ].filter((i) => i.show);
  const wantsYoto = has.has("yoto");
  const wantsAsk = has.has("ask");
  return (
    <>
      <span className="welcome-icon"><PartyPopper size={30} /></span>
      <h1>You're all set, {data.name}!</h1>
      <p className="welcome-lede">Here's what's connected. Anything you skipped can be done later from Settings.</p>
      <ul className="welcome-checklist">
        {items.map((i) => (
          <li key={i.label} className={i.ok ? "ok" : ""}>
            {i.ok ? <CheckCircle2 size={20} /> : <Circle size={20} />} {i.label}
            {!i.ok && <span className="muted"> · not yet</span>}
          </li>
        ))}
      </ul>
      <h2>What would you like to do first?</h2>
      <div className="use-choices">
        {wantsYoto && (
          <button type="button" className="use-choice" onClick={() => void onFinish("/yoto?new=1")}>
            <span className="use-icon"><SquareStack size={26} /></span>
            <strong>Make a Yoto card</strong>
            <span>Pick a book or podcast, and Audio fits it onto as few cards as possible.</span>
          </button>
        )}
        {wantsAsk && (
          <button type="button" className="use-choice" onClick={() => void onFinish("/library?listening=1")}>
            <span className="use-icon"><BookOpen size={26} /></span>
            <strong>Ask about a book</strong>
            <span>Open a book you're listening to and tap Ask.</span>
          </button>
        )}
        {has.has("folders") && (
          <button type="button" className="use-choice" onClick={() => void onFinish("/folders")}>
            <span className="use-icon"><FolderOpen size={26} /></span>
            <strong>Add a folder of audio</strong>
            <span>Upload files from this computer, like CDs you've copied.</span>
          </button>
        )}
        <button type="button" className="use-choice" onClick={() => void onFinish("/library")}>
          <span className="use-icon"><LibraryBig size={26} /></span>
          <strong>Look around my library</strong>
          <span>Everything you've connected, in one place.</span>
        </button>
      </div>
    </>
  );
}

function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
