import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  AudioLines,
  BookOpen,
  CheckCircle2,
  Circle,
  LibraryBig,
  MessageCircle,
  PartyPopper,
  Sparkles,
  SquareStack,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { AiQuickSetup } from "../components/AiSetup";
import { AudibleSignInSteps } from "../components/AudibleConnect";
import { Button, Note, SourceIcon, Spinner, errorText } from "../components/ui";
import { useOnboarding } from "../hooks/session";
import type { AudibleAccount, Onboarding, PrimaryUse } from "../types";

const STEPS = ["use", "audible", "yoto", "ai", "done"] as const;
type Step = (typeof STEPS)[number];

const STEP_LABELS: Record<Step, string> = {
  use: "Welcome",
  audible: "Audible",
  yoto: "Yoto",
  ai: "Ask (optional)",
  done: "Done",
};

/**
 * The first thing someone new sees: a few big, skippable steps to connect Audible, Yoto and (only if they want Ask)
 * an AI key. It can be opened again from Settings, or straight at one step with ?step=ai.
 */
export default function Welcome() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const status = useOnboarding();
  const step: Step = (STEPS as readonly string[]).includes(params.get("step") ?? "") ? (params.get("step") as Step) : "use";
  const index = STEPS.indexOf(step);

  function go(next: Step) {
    setParams({ step: next });
    window.scrollTo({ top: 0 });
  }
  const next = () => go(STEPS[Math.min(index + 1, STEPS.length - 1)]);
  const back = () => go(STEPS[Math.max(index - 1, 0)]);

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
          {STEPS.map((s, n) => (
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
        ) : step === "use" ? (
          <UseStep data={data} onNext={next} />
        ) : step === "audible" ? (
          <AudibleStep data={data} onNext={next} onBack={back} />
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

const USES: { id: PrimaryUse; icon: ReactNode; title: string; text: string }[] = [
  {
    id: "yoto",
    icon: <SquareStack size={28} />,
    title: "Making Yoto cards",
    text: "Put audiobooks and podcasts onto Make Your Own cards for a Yoto player.",
  },
  {
    id: "ask",
    icon: <MessageCircle size={28} />,
    title: "Asking about books",
    text: "Ask questions about the book you're listening to, with no spoilers past where you are.",
  },
  {
    id: "both",
    icon: <Sparkles size={28} />,
    title: "A bit of both",
    text: "Yoto cards and asking questions.",
  },
];

function UseStep({ data, onNext }: { data: Onboarding; onNext: () => void }) {
  const qc = useQueryClient();
  const [picked, setPicked] = useState<PrimaryUse>(data.primary_use);
  const [busy, setBusy] = useState(false);

  async function choose(use: PrimaryUse) {
    setPicked(use);
    setBusy(true);
    try {
      await api.patch("/onboarding", { primary_use: use });
      qc.invalidateQueries({ queryKey: ["onboarding"] });
      qc.invalidateQueries({ queryKey: ["session"] });
      onNext();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Hi {data.name}! Let's get you set up.</h1>
      <p className="welcome-lede">
        It takes about five minutes, and you can skip anything and come back to it later.
        {data.shared_with.length > 0 && (
          <> You're sharing <b>{data.household_name}</b> with {listNames(data.shared_with)}.</>
        )}
      </p>
      <h2>What will you mostly use Audio for?</h2>
      <div className="use-choices">
        {USES.map((u) => (
          <button key={u.id} type="button" className={`use-choice ${picked === u.id ? "picked" : ""}`} disabled={busy} onClick={() => void choose(u.id)}>
            <span className="use-icon">{u.icon}</span>
            <strong>{u.title}</strong>
            <span>{u.text}</span>
          </button>
        ))}
      </div>
      <p className="muted welcome-small">This only changes what's shown first. Everything stays available, and you can change it in Settings.</p>
    </>
  );
}

// ---------- 2. Audible ----------

function AudibleStep({ data, onNext, onBack }: { data: Onboarding; onNext: () => void; onBack: () => void }) {
  const qc = useQueryClient();
  const accounts = useQuery({ queryKey: ["audible-accounts"], queryFn: () => api.get<AudibleAccount[]>("/audible/accounts") });
  const locales = useQuery({ queryKey: ["locales"], queryFn: () => api.get<{ code: string; name: string }[]>("/audible/locales"), staleTime: Infinity });
  const [locale, setLocale] = useState("us");
  const [signingIn, setSigningIn] = useState<AudibleAccount | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const connected = data.audible.filter((a) => a.connected);
  const shared = data.shared_with.length > 0;

  async function start() {
    setError("");
    try {
      // Reuse an account added earlier that never finished signing in.
      const unfinished = (accounts.data ?? []).find((a) => !a.connected && a.is_mine) ?? (!shared ? (accounts.data ?? []).find((a) => !a.connected) : undefined);
      const account =
        unfinished && unfinished.locale === locale
          ? unfinished
          : await api.post<AudibleAccount>("/audible/accounts", { name: data.name, locale });
      qc.invalidateQueries({ queryKey: ["audible-accounts"] });
      setSigningIn(account);
    } catch (e) {
      setError(errorText(e));
    }
  }

  if (signingIn)
    return (
      <>
        <h1>Sign in to Audible</h1>
        <p className="welcome-lede">Three short steps. Amazon doesn't let other apps show its sign-in here, so it opens in a new tab.</p>
        <AudibleSignInSteps
          account={signingIn}
          onConnected={() => {
            setSigningIn(null);
            setAdding(false);
          }}
        />
        <StepNav onBack={() => setSigningIn(null)} skipLabel="Skip Audible for now" onSkip={onNext} />
      </>
    );

  return (
    <>
      <span className="welcome-icon"><SourceIcon kind="audible" size={30} /></span>
      <h1>{connected.length ? "Your Audible library" : "Connect your Audible library"}</h1>
      <p className="welcome-lede">
        {connected.length
          ? "Your audiobooks show up in the Library. New purchases appear by themselves."
          : "So the audiobooks you own show up here, ready to listen to, put on Yoto cards, or ask about. It signs in the same way the Audible app does on a new phone."}
      </p>
      {connected.length > 0 && (
        <div className="stack" style={{ "--gap": "8px", marginBottom: 18 } as React.CSSProperties}>
          {connected.map((a) => (
            <Done key={a.id}>{a.name}'s Audible is connected</Done>
          ))}
        </div>
      )}
      {(!connected.length || adding) && (
        <div className="stack" style={{ "--gap": "14px" } as React.CSSProperties}>
          <label className="field" style={{ maxWidth: 320 }}>
            <span>Which Audible store do you use?</span>
            <select className="select" value={locale} onChange={(e) => setLocale(e.target.value)}>
              {(locales.data ?? [{ code: "us", name: "United States" }]).map((l) => (
                <option key={l.code} value={l.code}>{l.name}</option>
              ))}
            </select>
          </label>
          {error && <Note tone="error">{error}</Note>}
          <Button variant="primary" size="lg" onClick={() => void start()} style={{ alignSelf: "flex-start" }}>
            Connect my Audible
          </Button>
        </div>
      )}
      {connected.length > 0 && !adding && (
        <button type="button" className="link-btn" onClick={() => setAdding(true)}>
          {shared ? "Add my own Audible account too" : "Add another person's Audible account"}
        </button>
      )}
      <StepNav
        onBack={onBack}
        onNext={onNext}
        nextLabel={connected.length ? "Continue" : "Skip, I don't use Audible"}
        nextVariant={connected.length ? "primary" : "ghost"}
      />
      {!connected.length && <p className="muted welcome-small">No Audible? Podcasts and your own audio files work too, from the menu.</p>}
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
  const optional = data.primary_use === "ask";

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
      const { authorize_url } = await api.post<{ authorize_url: string }>("/yoto/accounts", { name: data.name, return_to: "/welcome?step=yoto" });
      window.location.href = authorize_url;
    } catch (e) {
      setError(errorText(e));
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
          : "This lets Audio send cards to your Yoto app. You'll sign in on Yoto's own website, then come straight back here."}
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
  const yotoOnly = data.primary_use === "yoto";
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
  const items: { ok: boolean; label: string }[] = [
    { ok: data.audible.some((a) => a.connected), label: "Audible library" },
    { ok: data.yoto.connected.length > 0, label: "Yoto account" },
    { ok: data.ai.transcribe || data.ai.ask, label: "Ask & Transcribe" },
  ];
  const wantsYoto = data.primary_use !== "ask";
  const wantsAsk = data.primary_use === "ask" || data.primary_use === "both";
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
