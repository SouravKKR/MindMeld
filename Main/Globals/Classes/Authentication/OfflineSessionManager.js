import Persistence from "../Persistence.js";
import User from "../../Model/User.js";
import LicenseConstants from "../../Constants/LicenseConstants.js";
import UserIdentityConstants from "../../Constants/UserIdentityConstants.js";
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
 * The cached payload is JSON, stored at a GLOBAL (unprefixed)
 * Persistence path rather than under the user's storage prefix — it
 * must be readable at boot before any identity is known, since it is
 * the very thing that tells us which user was last signed in. Only the
 * most recent login is retained (a new login overwrites it; logout
 * clears it), which is exactly the "continue as the last logged-in
 * user" contract. There is no encryption-at-rest on the cache itself —
 * the data is just the User document, which the server would hand back
 * anyway on the next /GetUser call. The cache is read-only fallback
 * data, not a secret.
 */
class OfflineSessionManager
{
    // Stored at a GLOBAL (unprefixed) Persistence path — see
    // UserIdentityConstants.GLOBAL_KEYS. It has to be readable at boot,
    // offline, BEFORE the identity is resolved (the identity comes FROM
    // this cache), so it cannot live under Users/<identity>/.
    static #CACHE_PATH = UserIdentityConstants.OFFLINE_SESSION_CACHE_PATH;

    // Avatars are tiny; refuse anything unexpectedly large so a bad URL can't
    // bloat the cache file (and, on Tauri, the app-data directory).
    static #MAX_PROFILE_PICTURE_BYTES = 512 * 1024;

    static async saveCachedSession(user)
    {
        if (!user)
        {
            return;
        }

        // Fetch the profile picture (a cross-origin provider URL) and inline it
        // as a data URL while we still have the network. The offline service
        // worker only caches same-origin assets, so without this the avatar
        // <img> 404s offline. Best-effort: on any failure we cache the session
        // without an avatar rather than block the (more important) session save.
        const profilePictureDataUrl = await OfflineSessionManager.#fetchProfilePictureAsDataUrl(user.getProfilePictureUrl?.());

        try
        {
            await Persistence.write
            (
                OfflineSessionManager.#CACHE_PATH,
                {
                    cachedAt: Date.now(),
                    user: user.toJson(),
                    profilePictureDataUrl: profilePictureDataUrl
                },
                dataFormats.JSON
            );
        }
        catch (writeError)
        {
            console.warn("[OfflineSessionManager] Failed to cache session:", writeError);
        }
    }

    static async #fetchProfilePictureAsDataUrl(pictureUrl)
    {
        if (typeof pictureUrl !== "string" || pictureUrl.length === 0)
        {
            return null;
        }

        // Already inlined (e.g. a previously-hydrated user re-cached) — keep it.
        if (pictureUrl.startsWith("data:"))
        {
            return pictureUrl;
        }

        try
        {
            const response = await fetch(pictureUrl);

            if (!response.ok)
            {
                return null;
            }

            const blob = await response.blob();

            if (blob.size === 0 || blob.size > OfflineSessionManager.#MAX_PROFILE_PICTURE_BYTES)
            {
                return null;
            }

            return await new Promise((resolve) =>
            {
                const reader = new FileReader();
                reader.onloadend = () => resolve(typeof reader.result === "string" ? reader.result : null);
                reader.onerror   = () => resolve(null);
                reader.readAsDataURL(blob);
            });
        }
        catch (fetchError)
        {
            // Cross-origin CORS denial, offline, etc. — degrade gracefully.
            return null;
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
            const hydratedUser = User.fromJson(cached.user);

            // Expose the avatar captured (inlined) at cache time so the profile
            // picture still renders offline. It rides in additionalData under a
            // dedicated key rather than profilePictureUrl, because that field is
            // length-capped (2048 chars) and a data URL is far longer — the cap
            // would silently truncate it into a broken image. ProfileComponent
            // prefers this key. This lives only on the in-memory hydrated user
            // (a stale-offline session is never re-cached), so it never leaks
            // back into the persisted/synced user record.
            if (typeof cached.profilePictureDataUrl === "string"
                && cached.profilePictureDataUrl.startsWith("data:")
                && typeof hydratedUser.getAdditionalData === "function"
                && typeof hydratedUser.setAdditionalData === "function")
            {
                const additionalData = hydratedUser.getAdditionalData() || {};
                additionalData.offlineProfilePictureDataUrl = cached.profilePictureDataUrl;
                hydratedUser.setAdditionalData(additionalData);
            }

            return hydratedUser;
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
