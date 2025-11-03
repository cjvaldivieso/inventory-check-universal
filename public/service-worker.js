// 🚀 Shappi Inventory App Service Worker
// Bump version each time you change front-end files
const CACHE_NAME = "shappi-inventory-v5";
const ASSETS = [
  "/",
  "/index.html",
  "/app.js?v=5",
  "/styles.css",
  "/manifest.json",
  "/icons/shappi-inventory.png",
  "https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js"
];

// Install event — pre-cache essential files
self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
});

// Activate event — clean up old caches
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// Fetch event — network-first strategy for freshness
self.addEventListener("fetch", (event) => {
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

