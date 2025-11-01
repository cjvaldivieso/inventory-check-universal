const CACHE_NAME = "shappi-inventory-cache-v1";
const urlsToCache = [
  "/",
  "/index.html",
  "/app.js",
  "/styles.css",
  "/manifest.json",
  "/icons/shappi-logo-96.png",
  "/icons/shappi-logo-192.png",
  "/icons/shappi-logo-512.png"
];

// ✅ Install Service Worker
self.addEventListener("install", (event) => {
  console.log("📦 Service Worker installing...");
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log("Caching app files...");
      return cache.addAll(urlsToCache);
    })
  );
});

// ✅ Activate Service Worker
self.addEventListener("activate", (event) => {
  console.log("✅ Service Worker activated");
  event.waitUntil(
    caches.keys().then((cacheNames) =>
      Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            console.log("Deleting old cache:", cache);
            return caches.delete(cache);
          }
        })
      )
    )
  );
});

// ✅ Fetch Interception for Offline Mode
self.addEventListener("fetch", (event) => {
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      return (
        cachedResponse ||
        fetch(event.request).catch(() => {
          return new Response("⚠️ Offline: Resource unavailable.", {
            status: 503,
            headers: { "Content-Type": "text/plain" }
          });
        })
      );
    })
  );
});

