import User from "../Model/User.js";
import UserIdentityManager from "../Classes/UserIdentityManager.js";
import UserIdentityConstants from "../Constants/UserIdentityConstants.js";
import OfflineSessionManager from "../Classes/Authentication/OfflineSessionManager.js";
import OrganizationContextRegistry from "../Classes/Organization/OrganizationContextRegistry.js";
import PlanViewRegistry from "../Classes/View/PlanViewRegistry.js";
import BadgeCelebrationController from "../Classes/Streak/BadgeCelebrationController.js";
import MilestoneBadgeCelebrationController from "../Classes/Metrics/MilestoneBadgeCelebrationController.js";
import { userRoles } from "../Enumerations/UserRoles.js";
import { userViewKinds } from "../Enumerations/UserViewKinds.js";

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

            // Drop the institutes with the account, so the next person to sign
            // in on this device never sees the previous one's views offered. The
            // view record is cleared outright rather than set to a personal
            // organization view, so a simulated plan sandbox cannot survive a
            // logout either.
            await OrganizationContextRegistry.clear();
            await UserIdentityManager.clearViewContext(UserIdentityConstants.ANONYMOUS_IDENTITY);

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

            await OrganizationContextRegistry.setContexts(userJson.organizationContexts);
            await AuthenticationEvents.#restoreViewForUser(user);
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
            // Offline: the server could not confirm the membership, so the last
            // known list stands in. A view that has since been revoked collapses
            // back to the personal one as soon as /GetUser answers again.
            await OrganizationContextRegistry.loadStoredContexts();
            await AuthenticationEvents.#restoreViewForUser(cachedUser);
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
     * Puts the user back in the library they were last looking at.
     *
     * A reload must not silently move someone between libraries: a member who
     * left the app inside their institute's view and came back to their own
     * would think their organization's decks had been deleted. The stored view
     * is honoured only while it is still one the server just listed for this
     * account, so a membership that ended resolves cleanly to the personal view
     * instead of a namespace nothing will ever sync.
     *
     * The same rule applies to a simulated plan sandbox, keyed on the
     * administrator role instead of a membership: someone who lost the role while
     * a device still had the view open must land back in their own library rather
     * than in a namespace the server will now refuse to sync.
     *
     * Both branches read ONE stored record, so the two views cannot both be
     * restored — whichever branch runs writes a record that erases the other.
     */
    static async #restoreViewForUser(user)
    {
        const storedView = await UserIdentityManager.readStoredViewContext();

        if (storedView.kind === userViewKinds.PLAN)
        {
            // Answerable offline: the cached session user carries its role, and
            // the tier list is a shipped constant rather than anything fetched.
            const bStillAnAdministrator = typeof user.getRole === "function" && user.getRole() === userRoles.ADMIN;
            const bKnownTier = PlanViewRegistry.isKnownTierName(storedView.value);

            await UserIdentityManager.setPlanViewContext(user.getId(), (bStillAnAdministrator && bKnownTier) ? storedView.value : "");
            return;
        }

        const bStillAMember = storedView.value.length > 0 && OrganizationContextRegistry.findContext(storedView.value) !== null;

        await UserIdentityManager.setOrganizationContext(user.getId(), bStillAMember ? storedView.value : "");
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

        // The institute may have changed what this member is entitled to since
        // boot, and a removed membership must stop offering its view.
        await OrganizationContextRegistry.setContexts(userJson.organizationContexts);
        if (UserIdentityManager.isOrganizationContext() && OrganizationContextRegistry.findContext(UserIdentityManager.getOrganizationContextId()) === null)
        {
            await UserIdentityManager.setOrganizationContext(user.getId(), "");
        }

        // The same collapse for a simulated plan sandbox whose administrator role
        // has just been revoked. Done here rather than only at boot because this
        // runs on every refresh, and the alternative is a client that keeps
        // pushing a sandbox the server will refuse until the next reload.
        if (UserIdentityManager.isPlanViewContext() && (typeof user.getRole !== "function" || user.getRole() !== userRoles.ADMIN))
        {
            await UserIdentityManager.clearViewContext(user.getId());
        }

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
