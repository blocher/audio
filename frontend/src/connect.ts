// Signing in to another service (Yoto, OpenRouter) happens in this same tab: the browser goes to the service's
// sign-in page and comes straight back to the page it started from. Popups were easy to lose behind the browser
// window, and browsers warn about them, so the whole tab goes instead.

export interface ConnectResult {
  service: string;
  connected: boolean;
  error: string;
}

const CHANNEL = "audio-connect";

/** Where to come back to after signing in: this page, plus any extra query (e.g. reopen a dialog). */
export function here(extra: Record<string, string> = {}): string {
  const url = new URL(window.location.href);
  for (const key of ["connected", "error", "service"]) url.searchParams.delete(key);
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
  return url.pathname + url.search;
}

/** Go to a sign-in page in this tab. Never resolves: the page unloads. */
export function goToSignIn(url: string): Promise<never> {
  window.location.assign(url);
  return new Promise(() => {});
}

/** Called by /connected when an older popup sign-in finishes, so the window that opened it hears about it. */
export function announce(result: ConnectResult) {
  const channel = new BroadcastChannel(CHANNEL);
  channel.postMessage(result);
  channel.close();
}
