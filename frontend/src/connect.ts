// Signing in to another service without leaving the app: open its page in a small popup window, and wait for our
// /connected page (where the service sends people back) to report the result. A BroadcastChannel carries the news,
// because sign-in pages often cut the popup's link to its opener. If the browser blocks popups, the whole tab goes
// instead and /connected brings it back to where it started.

export interface ConnectResult {
  service: string;
  connected: boolean;
  error: string;
}

const CHANNEL = "audio-connect";

export function openPopup(url: string, name = "audio-connect"): Window | null {
  const width = 520;
  const height = 720;
  const left = Math.max(0, window.screenX + (window.outerWidth - width) / 2);
  const top = Math.max(0, window.screenY + (window.outerHeight - height) / 2);
  return window.open(url, name, `popup,width=${width},height=${height},left=${left},top=${top}`);
}

/** Open a sign-in page in a popup; resolves when it reports back (or rejects if the window is closed first). */
export function connectInPopup(url: string, service: string): Promise<ConnectResult> {
  const popup = openPopup(url);
  if (!popup) {
    window.location.href = url; // popups blocked: go in this tab, and /connected comes back here
    return new Promise(() => {});
  }
  return new Promise((resolve, reject) => {
    const channel = new BroadcastChannel(CHANNEL);
    const finish = (fn: () => void) => {
      channel.close();
      window.clearInterval(watch);
      fn();
    };
    channel.onmessage = (event: MessageEvent<ConnectResult>) => {
      if (event.data?.service === service) finish(() => resolve(event.data));
    };
    // A closed window with no news: they gave up. Give a late message a moment to arrive first.
    const watch = window.setInterval(() => {
      if (popup.closed) window.setTimeout(() => finish(() => reject(new Error("closed"))), 800);
    }, 500);
  });
}

/** Called by the /connected page inside the popup. */
export function announce(result: ConnectResult) {
  const channel = new BroadcastChannel(CHANNEL);
  channel.postMessage(result);
  channel.close();
}
