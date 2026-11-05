import { CloudOff, Sparkles, X } from "lucide-react";
import { useState } from "react";
import { applyUpdate, usePwa } from "../pwa";

/** A small pill at the top of the window: “new version ready” or “you’re offline”. */
export default function AppStatus() {
  const pwa = usePwa();
  const [dismissed, setDismissed] = useState(false);

  if (pwa.updateReady && !dismissed) {
    return (
      <div className="app-status" role="status">
        <Sparkles size={16} />
        <span>A new version of Audio is ready.</span>
        <button onClick={applyUpdate}>Reload</button>
        <button className="dismiss" onClick={() => setDismissed(true)} aria-label="Later">
          <X size={15} />
        </button>
      </div>
    );
  }
  if (!pwa.online) {
    return (
      <div className="app-status offline" role="status">
        <CloudOff size={16} />
        <span>You’re offline. Showing what’s saved on this device.</span>
      </div>
    );
  }
  return null;
}
