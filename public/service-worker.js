// --- VERSION THIS WHEN YOU DEPLOY ---
const CACHE_VERSION = "shappi-cache-v5"; // bump v# on every deploy
const RUNTIME = CACHE_VERSION;

self.addEventListener("install", (event) => {
  self.skipWaiting(); // activate immediately
  event.waitUntil((async () => {
    const cache = await caches.open(RUNTIME);
    // Pre-cache the app shell only if you want; keep minimal
    await cache.addAll([
      "/",           // index.html
      "/app.js",
      "/manifest.json",
      "/icons/shappi-inventory.png"
    ]);
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => key !== RUNTIME)
        .map((key) => caches.delete(key))
    );
    await self.clients.claim(); // take control immediately
  })());
});

// Network-first for HTML/JS to avoid stale builds
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle same-origin requests
  if (url.origin !== self.location.origin) return;

  // Network-first for HTML/JS/CSS
  if (req.destination === "document" || req.url.endsWith(".js") || req.url.endsWith(".css")) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req, { cache: "no-store" });
        return fresh;
      } catch (e) {
        const cache = await caches.open(RUNTIME);
        const cached = await cache.match(req);
        return cached || caches.match("/");
      }
    })());
    return;
  }

  // Cache-first for images/icons
  if (req.destination === "image") {
    event.respondWith((async () => {
      const cache = await caches.open(RUNTIME);
      const cached = await cache.match(req);
      if (cached) return cached;
      const fresh = await fetch(req);
      cache.put(req, fresh.clone());
      return fresh;
    })());
    return;
  }

  // Default: go to network
  event.respondWith(fetch(req));
});

