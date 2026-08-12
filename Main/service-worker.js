// CogniumLearn offline cache — used ONLY by the native desktop/mobile shell.
//
// The Tauri app loads the production site directly (https://learn.cogniumlabs.io); this service
// worker stores the pages + static assets it loads so that a later launch/reload works with no
// network. It is registered ONLY from inside the native shell (see OfflineCacheManager, gated on
// Platform.get() === APP), so ordinary web browsers never install it and the web version is
// completely unaffected.
//
// Strategy:
//   - Navigations (the HTML shell) and static assets (js/css/fonts/images/wasm/json/…): NETWORK
//     FIRST — when online the freshest copy is served and the cache is refreshed; when offline the
//     last cached copy is served. This is what makes "load online, keep working offline" true.
//   - Everything else (API / dynamic / auth endpoints, non-GET, cross-origin): passthrough, never
//     cached. Offline data behaviour is handled by the app itself (Persistence), not here.

const OFFLINE_CACHE_NAME = "cogniumlearn-offline-v2";

const STATIC_ASSET_EXTENSIONS = new Set([
    "html", "js", "mjs", "css", "json", "wasm", "bin",
    "png", "jpg", "jpeg", "gif", "webp", "svg", "ico",
    "woff", "woff2", "ttf", "otf", "map",
]);

// Paths this cache must never touch, however cacheable the extension looks.
//
// The on-device model weights live under /Assets/Models/ and are shards named
// .bin, .json and .wasm — every one of which is in the list above. Caching them
// here would store a SECOND full copy of a model that already has its own
// store: WebLLM keeps the browser tier's shards in its own Cache backend, and
// the native tier writes its weights straight to the app data directory. The
// duplicate is a gigabyte or more per model, invisible, and buys nothing —
// neither engine would ever read it.
//
// It is also the wrong layer to solve offline weights at. A model is only
// usable if the engine that owns it has it, so "is the model available
// offline" is that engine's question, not this cache's.
const NEVER_CACHED_PATH_PREFIXES = [
    "/Assets/Models/",
    "/Assets/Runtime/",
];

self.addEventListener("install", (installEvent) =>
{
    // Take over as soon as installed so offline support is active on the next navigation.
    self.skipWaiting();
});

self.addEventListener("activate", (activateEvent) =>
{
    activateEvent.waitUntil((async () =>
    {
        const cacheNames = await caches.keys();

        await Promise.all(cacheNames.map((cacheName) =>
        {
            if (cacheName !== OFFLINE_CACHE_NAME)
            {
                return caches.delete(cacheName);
            }

            return Promise.resolve();
        }));

        await self.clients.claim();
    })());
});

function isCacheableRequest(request)
{
    if (request.method !== "GET")
    {
        return false;
    }

    let requestUrl;

    try
    {
        requestUrl = new URL(request.url);
    }
    catch (parseError)
    {
        return false;
    }

    // Only ever cache assets from our own origin — never third-party scripts or API hosts.
    if (requestUrl.origin !== self.location.origin)
    {
        return false;
    }

    if (NEVER_CACHED_PATH_PREFIXES.some((excludedPrefix) => requestUrl.pathname.startsWith(excludedPrefix)))
    {
        return false;
    }

    // The HTML shell arrives as a navigation request (no useful extension on the path).
    if (request.mode === "navigate")
    {
        return true;
    }

    const lastPathSegment = requestUrl.pathname.split("/").pop() || "";
    const extensionSeparatorIndex = lastPathSegment.lastIndexOf(".");

    if (extensionSeparatorIndex < 0)
    {
        // No extension → treat as a dynamic/API endpoint and leave it to the network.
        return false;
    }

    const extension = lastPathSegment.slice(extensionSeparatorIndex + 1).toLowerCase();
    return STATIC_ASSET_EXTENSIONS.has(extension);
}

async function networkFirstThenCache(request)
{
    const cache = await caches.open(OFFLINE_CACHE_NAME);

    try
    {
        const networkResponse = await fetch(request);

        // Only store complete, same-origin success responses.
        if (networkResponse && networkResponse.status === 200 && networkResponse.type === "basic")
        {
            cache.put(request, networkResponse.clone());
        }

        return networkResponse;
    }
    catch (networkError)
    {
        const cachedResponse = await cache.match(request);

        if (cachedResponse)
        {
            return cachedResponse;
        }

        // For a navigation with nothing cached yet, fall back to any cached shell entry.
        if (request.mode === "navigate")
        {
            const cachedShell = await cache.match("/index.html") || await cache.match("/");

            if (cachedShell)
            {
                return cachedShell;
            }
        }

        throw networkError;
    }
}

self.addEventListener("fetch", (fetchEvent) =>
{
    if (isCacheableRequest(fetchEvent.request) === false)
    {
        return;
    }

    fetchEvent.respondWith(networkFirstThenCache(fetchEvent.request));
});
