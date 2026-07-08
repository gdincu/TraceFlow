const CACHE_NAME = "traceflow-v2";
// Relative paths so the app also works when hosted under a sub-path.
const ASSETS_TO_CACHE = [
    "./",
    "./index.html",
    "./css/style.css",
    "./js/script.js",
    "./data/ride.gpx",
    "./assets/bike.png",
    "./favicon.ico",
];

self.addEventListener("install", event => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            console.log("TraceFlow: Pre-caching app shell");
            return cache.addAll(ASSETS_TO_CACHE);
        })
    );
});

self.addEventListener("activate", event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.map(key => {
                if (key !== CACHE_NAME) {
                    console.log("TraceFlow: Clearing old cache", key);
                    return caches.delete(key);
                }
            })))
            .then(() => self.clients.claim())
    );
});

self.addEventListener("fetch", event => {
    if (event.request.method !== "GET") return;

    const sameOrigin = new URL(event.request.url).origin === self.location.origin;
    if (sameOrigin) {
        // Network-first keeps our own assets fresh; the cache is the offline fallback.
        event.respondWith(
            fetch(event.request)
                .then(res => {
                    if (res.ok) {
                        const copy = res.clone();
                        caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
                    }
                    return res;
                })
                .catch(() => caches.match(event.request))
        );
    } else {
        event.respondWith(
            caches.match(event.request).then(cached => cached || fetch(event.request))
        );
    }
});
