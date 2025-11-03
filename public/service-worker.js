// Version bump each time you update front-end files
const CACHE_NAME = "inv-check-cache-v7";

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => 
      cache.addAll([
        "/",
        "/index.html",
        "/styles.css",
        "/app.js",
        "/manifest.json",
        "https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js"
      ])
    )
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.map(n => (n !== CACHE_NAME ? caches.delete(n) : null)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});

