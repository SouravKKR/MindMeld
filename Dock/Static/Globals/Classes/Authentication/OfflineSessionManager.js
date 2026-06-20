import Persistence from "../Persistence.js";
import User from "../../Model/User.js";
import LicenseConstants from "../../Constants/LicenseConstants.js";
import { dataFormats } from "../../Enumerations/DataFormats.js";

/**
 * OfflineSessionManager
 *
 * Caches the most recent user object to local storage so the app can
 * continue functioning when the network is unreachable.
 *
 * Trust model:
 *   - The cache is for *continuing to use what's already loaded*, not
 *     for proving identity to the server. The server still validates
 *     every protected request via the sessionId cookie.
 *   - On 401 from /GetUser we treat that as an authoritative "you are
 *     signed out" and clear the cache.
 *   - On network error from /GetUser we treat that as offline and
 *     hydrate from cache (subject to the hard-expiry below).
 *   - Hard expiry: cache older than OFFLINE_SESSION_HARD_EXPIRY_DAYS
 *     is discarded. A device that hasn't been online in over a month
 *     loses its offline session.
 *
 * The cached payload is JSON, namespaced under the user's storage
 * prefix in Persistence. There is no encryption-at-rest on the cache
 * itself — Persistence already namespaces by userId and the data is
 * just the User document, which the server would hand back anyway on
 * the next /GetUser call. The cache is read-only fallback data, not a
 * secret.
 */
class OfflineSessionManager
{
    static #CACHE_PATH = "Session/Cache.json";

    static async saveCachedSession(user)
    {
        if (!user)
        {
            return;
        }

        try
        {
            await Persistence.write
            (
                OfflineSessionManager.#CACHE_PATH,
                {
                    cachedAt: Date.now(),
                    user: user.toJson()
                },
                dataFormats.JSON
            );
        }
        catch (writeError)
        {
            console.warn("[OfflineSessionManager] Failed to cache session:", writeError);
        }
    }

    static async tryHydrateCachedSession()
    {
        let cached = null;

        try
        {
            cached = await Persistence.read(OfflineSessionManager.#CACHE_PATH, dataFormats.JSON);
        }
        catch (readError)
        {
            return null;
        }

        if (!cached || !cached.user || !cached.cachedAt)
        {
            return null;
        }

        const ageMilliseconds = Date.now() - cached.cachedAt;
        const hardExpiryMilliseconds = LicenseConstants.OFFLINE_SESSION_HARD_EXPIRY_DAYS * 24 * 60 * 60 * 1000;

        if (ageMilliseconds > hardExpiryMilliseconds)
        {
            await OfflineSessionManager.clearCachedSession();
            return null;
        }

        try
        {
            return User.fromJson(cached.user);
        }
        catch (parseError)
        {
            console.error("[OfflineSessionManager] Cached user parse failed:", parseError);
            return null;
        }
    }

    static async clearCachedSession()
    {
        try
        {
            await Persistence.delete(OfflineSessionManager.#CACHE_PATH);
        }
        catch (deleteError)
        {
            // Persistence may not expose delete on all platforms; overwriting
            // with null is a safe fallback.
            try
            {
                await Persistence.write
                (
                    OfflineSessionManager.#CACHE_PATH,
                    { cachedAt: 0, user: null },
                    dataFormats.JSON
                );
            }
            catch (overwriteError)
            {
            }
        }
    }
}

export default OfflineSessionManager;
