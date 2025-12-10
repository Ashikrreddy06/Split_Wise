// Very simple service worker just to make the app installable
const CACHE_NAME = "splitit-cache-v1";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./script.js",
  "./manifest.json"
];

// Install: cache core assets
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
});

// Activate: cleanup old caches if any
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME)
          .map((k) => caches.delete(k))
      )
    )
  );
});

// Fetch: network first, fallback to cache
self.addEventListener("fetch", (event) => {
  const req = event.request;
  event.respondWith(
    fetch(req).catch(() => caches.match(req))
  );
});
