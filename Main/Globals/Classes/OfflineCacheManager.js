import Platform from "./Platform.js";
import { platforms } from "../Enumerations/Platforms.js";

// Registers the offline service worker, but ONLY inside the native desktop/mobile shell. In an
// ordinary web browser Platform.get() returns WEB and this does nothing, so the service worker is
// never installed for web visitors — the web version is unaffected by the offline feature.
//
// The service worker (service-worker.js at the site root) then caches the pages and static assets
// the app loads, so a later reload works with no network. Registration failures are swallowed:
// offline caching is a best-effort enhancement and must never block the app from loading.
class OfflineCacheManager
{
    static SERVICE_WORKER_URL = "/service-worker.js";

    static register()
    {
        if (Platform.get() !== platforms.APP)
        {
            return;
        }

        if (typeof navigator === "undefined" || "serviceWorker" in navigator === false)
        {
            return;
        }

        window.addEventListener("load", () =>
        {
            navigator.serviceWorker.register(OfflineCacheManager.SERVICE_WORKER_URL).catch((registrationError) =>
            {
                console.warn("[OfflineCacheManager] Service worker registration failed; offline support is disabled.", registrationError);
            });
        });
    }
}

OfflineCacheManager.register();

export default OfflineCacheManager;
