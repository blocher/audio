/* Audio service worker. The build (vite.config.ts → pwaPlugin) fills in VERSION and PRECACHE. */
/* global self, caches, fetch, Response, URL */

const VERSION = "__PWA_VERSION__";
const PRECACHE = __PWA_PRECACHE__;

const SHELL_CACHE = `audio-shell-${VERSION}`;
// Signed-in data. The page deletes these on sign-out (see src/pwa.ts → clearUserCaches).
const API_CACHE = "audio-api";
const IMAGE_CACHE = "audio-images";
const IMAGE_LIMIT = 400;
const NAVIGATION_TIMEOUT_MS = 4000;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(PRECACHE.map((url) => new Request(url, { cache: "reload" })))),
  );
  // No skipWaiting here: an open tab keeps its version until the person chooses “Reload” (SKIP_WAITING below).
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith("audio-shell-") && k !== SHELL_CACHE).map((k) => caches.delete(k)));
      if (self.registration.navigationPreload) await self.registration.navigationPreload.enable();
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  const type = event.data?.type;
  if (type === "SKIP_WAITING") self.skipWaiting();
  if (type === "CLEAR_USER_DATA") event.waitUntil(Promise.all([caches.delete(API_CACHE), caches.delete(IMAGE_CACHE)]));
  if (type === "GET_VERSION") event.ports[0]?.postMessage(VERSION);
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  // Cross-origin requests (Audible covers, fonts CDNs) go straight to the network: the page's CSP governs them.
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(navigation(event));
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    // Audio is byte-range streamed by nginx; leave it (and anything ranged) alone. Covers are cached as images.
    if (request.headers.has("range")) return;
    if (request.destination === "image") {
      event.respondWith(staleWhileRevalidate(event, IMAGE_CACHE, true));
      return;
    }
    if (url.pathname.startsWith("/api/media/")) return;
    event.respondWith(apiNetworkFirst(request));
    return;
  }

  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
    return;
  }

  if (request.destination === "image") {
    event.respondWith(staleWhileRevalidate(event, IMAGE_CACHE, true));
    return;
  }

  event.respondWith(staleWhileRevalidate(event, SHELL_CACHE, false));
});

/** Fresh HTML when the network answers quickly; the cached shell when it is slow or gone. */
async function navigation(event) {
  const shell = () => caches.match("/index.html", { cacheName: SHELL_CACHE }).then((r) => r || caches.match("/index.html"));
  try {
    const network = (async () => (await event.preloadResponse) || (await fetch(event.request)))();
    const timeout = new Promise((resolve) => setTimeout(resolve, NAVIGATION_TIMEOUT_MS, "timeout"));
    const winner = await Promise.race([network, timeout]);
    if (winner === "timeout") {
      const cached = await shell();
      return cached || (await network);
    }
    return winner;
  } catch {
    return (await shell()) || offlineResponse("text/html");
  }
}

/** Library data: always try the server first; fall back to the last copy when offline. */
async function apiNetworkFirst(request) {
  const cache = await caches.open(API_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok && (response.headers.get("content-type") || "").includes("application/json")) {
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) {
      const headers = new Headers(cached.headers);
      headers.set("X-Audio-Offline", "1");
      return new Response(cached.body, { status: cached.status, statusText: cached.statusText, headers });
    }
    return offlineResponse("application/json");
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

async function staleWhileRevalidate(event, cacheName, trim) {
  const { request } = event;
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const refresh = fetch(request)
    .then(async (response) => {
      if (response.ok && response.type === "basic") {
        await cache.put(request, response.clone());
        if (trim) await trimCache(cache, IMAGE_LIMIT);
      }
      return response;
    })
    .catch(() => undefined);
  if (cached) {
    event.waitUntil(refresh);
    return cached;
  }
  return (await refresh) || offlineResponse(request.destination === "image" ? "image" : "text/plain");
}

async function trimCache(cache, limit) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - limit; i++) await cache.delete(keys[i]);
}

function offlineResponse(kind) {
  if (kind === "application/json") {
    return new Response(JSON.stringify({ detail: "You’re offline, and this hasn’t been saved on this device yet." }), {
      status: 503,
      headers: { "Content-Type": "application/json", "X-Audio-Offline": "1" },
    });
  }
  if (kind === "text/html") {
    return new Response(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Audio</title>' +
        '<body style="font-family:system-ui;background:#faefe0;color:#3a2418;display:grid;place-items:center;height:100vh;margin:0">' +
        "<p>You’re offline. Audio will load when you’re back online.</p>",
      { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  }
  return new Response("", { status: 503, statusText: "Offline" });
}
