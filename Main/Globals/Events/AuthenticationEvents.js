import User from "../Model/User.js";
import UserIdentityManager from "../Classes/UserIdentityManager.js";
import UserIdentityConstants from "../Constants/UserIdentityConstants.js";
import OfflineSessionManager from "../Classes/Authentication/OfflineSessionManager.js";
import BadgeCelebrationController from "../Classes/Streak/BadgeCelebrationController.js";
import MilestoneBadgeCelebrationController from "../Classes/Metrics/MilestoneBadgeCelebrationController.js";

class AuthenticationEvents
{
    static ON_USER_LOGGED_IN = "ON_USER_LOGGED_IN"
    static ON_USER_LOGGED_OUT = "ON_USER_LOGGED_OUT"

    static SESSION_STATE_FRESH = "FRESH";
    static SESSION_STATE_STALE_OFFLINE = "STALE_OFFLINE";

    static
    {
        console.log("Loading AuthenticationEvents...");

        AuthenticationEvents.#bootstrap();

        window.addEventListener(AuthenticationEvents.ON_USER_LOGGED_IN, async (event) =>
        {
            const user = event.detail.user;
            const sessionState = event.detail.sessionState || AuthenticationEvents.SESSION_STATE_FRESH;

            sessionStorage.setItem("user", JSON.stringify(user.toJson()));
            window["user"] = user;
            window["sessionState"] = sessionState;

            // Only cache fresh server-validated sessions. A STALE_OFFLINE
            // hydration just consumes the cache; rewriting it would
            // refresh cachedAt and defeat the hard-expiry check.
            if (sessionState === AuthenticationEvents.SESSION_STATE_FRESH)
            {
                await OfflineSessionManager.saveCachedSession(user);
            }

            document.querySelectorAll("profile-component").forEach((component) =>
            {
                component.refresh();
            });

            // The streak is advanced server-side on /GetUser, so a fresh login
            // payload may carry newly-earned badges to celebrate. Skip stale
            // offline hydrations (no server round-trip, and the ack POST would
            // fail). Fire-and-forget so it never holds up the login handler.
            if (sessionState === AuthenticationEvents.SESSION_STATE_FRESH)
            {
                BadgeCelebrationController.evaluate(user);
                MilestoneBadgeCelebrationController.evaluate(user);
            }
        });

        window.addEventListener(AuthenticationEvents.ON_USER_LOGGED_OUT, async () =>
        {
            sessionStorage.removeItem("user");
            window["user"] = null;
            window["sessionState"] = null;
            await OfflineSessionManager.clearCachedSession();

            document.querySelectorAll("profile-component").forEach((component) =>
            {
                if (typeof component.refresh === "function")
                {
                    component.refresh();
                }
            });
        });
    }

    static async #bootstrap()
    {
        let response = null;
        let networkError = null;

        try
        {
            response = await fetch("/GetUser");
        }
        catch (fetchError)
        {
            networkError = fetchError;
            console.warn("[AuthenticationEvents] /GetUser network error — attempting offline hydration:", fetchError);
        }

        if (response && response.ok)
        {
            const userJson = await response.json();
            const user = User.fromJson(userJson);

            await UserIdentityManager.setIdentity(user.getId());
            window.dispatchEvent(new CustomEvent(AuthenticationEvents.ON_USER_LOGGED_IN, {
                detail: { user, sessionState: AuthenticationEvents.SESSION_STATE_FRESH }
            }));
            return;
        }

        // 401 from the server is authoritative — clear cache + log out.
        if (response && response.status === 401)
        {
            await OfflineSessionManager.clearCachedSession();
            await UserIdentityManager.setIdentity(UserIdentityConstants.ANONYMOUS_IDENTITY);
            window.dispatchEvent(new CustomEvent(AuthenticationEvents.ON_USER_LOGGED_OUT));
            return;
        }

        // Either we got a network error or a non-401 non-OK status — treat
        // as offline. Try to hydrate from the offline cache.
        const cachedUser = await OfflineSessionManager.tryHydrateCachedSession();

        if (cachedUser)
        {
            await UserIdentityManager.setIdentity(cachedUser.getId());
            window.dispatchEvent(new CustomEvent(AuthenticationEvents.ON_USER_LOGGED_IN, {
                detail: { user: cachedUser, sessionState: AuthenticationEvents.SESSION_STATE_STALE_OFFLINE }
            }));

            // When connectivity is restored, re-validate. If the server says
            // we're logged out (401), the cache gets cleared and we'll fire
            // ON_USER_LOGGED_OUT then.
            AuthenticationEvents.#scheduleOnlineRecheck();
            return;
        }

        await UserIdentityManager.setIdentity(UserIdentityConstants.ANONYMOUS_IDENTITY);
        window.dispatchEvent(new CustomEvent(AuthenticationEvents.ON_USER_LOGGED_OUT));
    }

    /**
     * Re-fetches the authenticated user from the server and updates every
     * cached copy in place (window state, sessionStorage, offline cache,
     * mounted profile components). Server-side values such as the credit
     * balance change outside this client, so callers that display them
     * should refresh before rendering. Returns the fresh User on success,
     * or null when the server is unreachable or the response is not OK.
     * A 401 is authoritative — it clears the offline cache and fires
     * ON_USER_LOGGED_OUT before returning null.
     */
    static async refreshUserFromServer()
    {
        let response = null;

        try
        {
            response = await fetch("/GetUser");
        }
        catch (networkError)
        {
            console.warn("[AuthenticationEvents] /GetUser refresh failed — keeping cached user:", networkError);
            return null;
        }

        if (response.status === 401)
        {
            await OfflineSessionManager.clearCachedSession();
            window.dispatchEvent(new CustomEvent(AuthenticationEvents.ON_USER_LOGGED_OUT));
            return null;
        }

        if (!response.ok)
        {
            return null;
        }

        const userJson = await response.json();
        const user = User.fromJson(userJson);

        // storageUsage is a transient, server-measured sibling of the user JSON
        // (see HandleGetUser) — it is NOT part of the User model, so stash the
        // live measurement on the window for the Settings storage meter to read.
        // Null when the server couldn't measure it this time.
        window["storageUsage"] = userJson.storageUsage || null;

        sessionStorage.setItem("user", JSON.stringify(user.toJson()));
        window["user"] = user;
        window["sessionState"] = AuthenticationEvents.SESSION_STATE_FRESH;
        await OfflineSessionManager.saveCachedSession(user);

        document.querySelectorAll("profile-component").forEach((component) =>
        {
            if (typeof component.refresh === "function")
            {
                component.refresh();
            }
        });

        // A refresh hits /GetUser, which advances the streak server-side, so
        // the payload may carry a freshly-earned badge (e.g. the user crossed
        // a threshold today). Celebrate any not yet acknowledged.
        BadgeCelebrationController.evaluate(user);
        MilestoneBadgeCelebrationController.evaluate(user);

        return user;
    }

    static #recheckScheduled = false;

    static #scheduleOnlineRecheck()
    {
        if (AuthenticationEvents.#recheckScheduled)
        {
            return;
        }
        AuthenticationEvents.#recheckScheduled = true;

        const tryRevalidate = async () =>
        {
            try
            {
                await AuthenticationEvents.refreshUserFromServer();
            }
            catch (revalidateError)
            {
            }
        };

        window.addEventListener("online", tryRevalidate);

        const intervalMilliseconds = 30 * 1000;
        const intervalId = setInterval(async () =>
        {
            if (navigator.onLine === false)
            {
                return;
            }
            await tryRevalidate();
        }, intervalMilliseconds);

        window.addEventListener(AuthenticationEvents.ON_USER_LOGGED_OUT, () =>
        {
            clearInterval(intervalId);
            AuthenticationEvents.#recheckScheduled = false;
        }, { once: true });
    }
}

export default AuthenticationEvents;
