/*
 * TriageGrid field PWA service worker.
 * Strategy: network-first for data/API (freshness matters), cache-first for
 * the static shell so the app boots with zero connectivity. Cached assigned
 * incident DATA lives in IndexedDB (see lib/offline/db.ts), not here — the SW
 * only guarantees the shell renders offline.
 */
const SHELL_CACHE = "tg-shell-v1";
const SHELL_ASSETS = ["/", "/field", "/icon.svg", "/manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL_ASSETS)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET") return; // mutations go through the outbox
  if (url.pathname.startsWith("/api/") || url.hostname.includes("supabase")) return;

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(SHELL_CACHE).then((c) => c.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request).then((hit) => hit ?? caches.match("/field"))),
  );
});
