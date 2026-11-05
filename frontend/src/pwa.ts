// Installable-app plumbing: service worker registration and updates, the install prompt, and online state.
import { useSyncExternalStore } from "react";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

interface PwaState {
  /** A new version has installed and is waiting for the person to reload into it. */
  updateReady: boolean;
  /** The browser offered an install prompt we can show from our own button. */
  canInstall: boolean;
  /** Running as an installed app (home screen, dock, app window). */
  standalone: boolean;
  online: boolean;
}

const USER_CACHES = ["audio-api", "audio-images"];
const UPDATE_CHECK_MS = 60 * 60 * 1000;

let state: PwaState = {
  updateReady: false,
  canInstall: false,
  standalone: detectStandalone(),
  online: typeof navigator === "undefined" ? true : navigator.onLine,
};
const listeners = new Set<() => void>();
let installEvent: BeforeInstallPromptEvent | null = null;
let waiting: ServiceWorker | null = null;
let reloading = false;

function set(patch: Partial<PwaState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

function detectStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: minimal-ui)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function usePwa(): PwaState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

export function isIos(): boolean {
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1);
}

/** Wire everything up once, at startup. The service worker only runs in production builds. */
export function initPwa() {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installEvent = event as BeforeInstallPromptEvent;
    set({ canInstall: true });
  });
  window.addEventListener("appinstalled", () => {
    installEvent = null;
    set({ canInstall: false, standalone: detectStandalone() });
  });
  window.matchMedia("(display-mode: standalone)").addEventListener("change", () => set({ standalone: detectStandalone() }));
  window.addEventListener("online", () => set({ online: true }));
  window.addEventListener("offline", () => set({ online: false }));

  if (!("serviceWorker" in navigator) || !import.meta.env.PROD) return;

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!reloading) return;
    window.location.reload();
  });

  window.addEventListener("load", async () => {
    try {
      const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
      const track = (worker: ServiceWorker | null) => {
        if (!worker) return;
        const check = () => {
          // Only an *update* waits; the very first install has no controller to replace.
          if (worker.state === "installed" && navigator.serviceWorker.controller) {
            waiting = worker;
            set({ updateReady: true });
          }
        };
        check();
        worker.addEventListener("statechange", check);
      };
      track(registration.waiting);
      registration.addEventListener("updatefound", () => track(registration.installing));

      const checkForUpdate = () => registration.update().catch(() => undefined);
      window.setInterval(checkForUpdate, UPDATE_CHECK_MS);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") checkForUpdate();
      });
    } catch {
      /* unsupported or blocked: the site still works as a plain web page */
    }
  });
}

/** Switch to the waiting version and reload into it. */
export function applyUpdate() {
  if (!waiting) return window.location.reload();
  reloading = true;
  waiting.postMessage({ type: "SKIP_WAITING" });
}

export async function promptInstall(): Promise<boolean> {
  if (!installEvent) return false;
  await installEvent.prompt();
  const choice = await installEvent.userChoice;
  installEvent = null;
  set({ canInstall: false });
  return choice.outcome === "accepted";
}

/** Drop this person's cached library data and covers, e.g. on sign-out. */
export async function clearUserCaches() {
  if (!("caches" in window)) return;
  await Promise.all(USER_CACHES.map((name) => caches.delete(name)));
}

export interface StorageInfo {
  usage: number;
  quota: number;
  persisted: boolean;
}

export async function storageInfo(): Promise<StorageInfo | null> {
  if (!navigator.storage?.estimate) return null;
  const [estimate, persisted] = await Promise.all([navigator.storage.estimate(), navigator.storage.persisted?.() ?? false]);
  return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0, persisted };
}

/** Ask the browser not to evict our caches under storage pressure. */
export async function requestPersistence(): Promise<boolean> {
  return (await navigator.storage?.persist?.()) ?? false;
}
