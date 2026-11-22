import { CheckCircle2, AlertTriangle } from "lucide-react";
import { useEffect, useState } from "react";
import { announce } from "../connect";
import { Spinner } from "../components/ui";

const NAMES: Record<string, string> = { openrouter: "OpenRouter", yoto: "Yoto" };

/**
 * Where a sign-in on another site (OpenRouter, Yoto) ends. In a popup it tells the app's window and closes; in a
 * normal tab it carries on to the page the person started from.
 */
export default function Connected() {
  const params = new URLSearchParams(window.location.search);
  const service = params.get("service") ?? "";
  const error = params.get("error") ?? "";
  const connected = params.get("connected") === "1";
  const popup = params.get("popup") === "1";
  const returnTo = params.get("return_to") || "/";
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    const back = () => {
      const next = new URL(returnTo, window.location.origin);
      if (connected) next.searchParams.set("connected", "1");
      if (error) next.searchParams.set("error", error);
      window.location.replace(next.pathname + next.search);
    };
    if (!popup) return back();
    announce({ service, connected, error });
    window.close();
    // Still here: the browser opened this as a tab rather than a popup. Go back to the app in it.
    const timer = window.setTimeout(() => (window.opener ? setStuck(true) : back()), 600);
    return () => window.clearTimeout(timer);
  }, [service, connected, error, popup, returnTo]);

  return (
    <div style={{ display: "grid", placeItems: "center", minHeight: "100vh", padding: 24, textAlign: "center" }}>
      <div className="stack" style={{ "--gap": "12px", alignItems: "center" } as React.CSSProperties}>
        {error ? <AlertTriangle size={36} color="var(--berry)" /> : connected ? <CheckCircle2 size={36} color="var(--sage)" /> : <Spinner size={28} />}
        <h2>{error ? "That didn't work" : `${NAMES[service] ?? "It"} is connected`}</h2>
        {error && <p className="muted">{error}</p>}
        {stuck && <p className="muted">You can close this window and go back to Audio.</p>}
      </div>
    </div>
  );
}
