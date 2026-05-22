import IndexedDbHelper from "./IndexedDbHelper.js";
import UserIdentityConstants from "../Constants/UserIdentityConstants.js";
import UserIdentityEvents from "../Events/UserIdentityEvents.js";

/**
 * UserIdentityManager
 *
 * Single source of truth for the currently active storage identity.
 * - For a logged-in user, identity is the user's id (e.g. Google sub).
 * - For an unauthenticated user, identity is "anonymous".
 *
 * Storage paths used by Persistence are namespaced under
 * `Users/<identity>/...`, which gives logged-in users isolated data,
 * keeps anonymous data separate from any account, and prevents the
 * "logout → login → ghost entities" bug where the previous user's
 * data leaks into the new user's session.
 *
 * Persists its own current value to IndexedDbHelper directly (NOT
 * Persistence — Persistence depends on this class). Reading is
 * synchronous after boot; setIdentity() is async only because of the
 * underlying IndexedDB write.
 */
class UserIdentityManager
{
    static #IDENTITY_STORAGE_KEY = "currentUserIdentity";

    static #currentIdentity = null;
    static #bReady          = false;

    /**
     * Sets the active identity. If it differs from the current one,
     * fires UserIdentityEvents.CHANGED. If this is the first call after
     * boot, also fires UserIdentityEvents.READY (exactly once).
     * @param {string|null} identity
     */
    static async setIdentity(identity)
    {
        const newIdentity = identity || UserIdentityConstants.ANONYMOUS_IDENTITY;
        const previousIdentity = UserIdentityManager.#currentIdentity;
        const bSameAsCurrent = previousIdentity === newIdentity;
        const bAlreadyReady = UserIdentityManager.#bReady;

        if (bSameAsCurrent && bAlreadyReady)
        {
            return;
        }

        UserIdentityManager.#currentIdentity = newIdentity;

        try
        {
            await IndexedDbHelper.setValue(UserIdentityManager.#IDENTITY_STORAGE_KEY, newIdentity);
        }
        catch (error)
        {
            console.error("[UserIdentityManager] Failed to persist identity:", error);
        }

        UserIdentityManager.#bReady = true;

        window.dispatchEvent(new CustomEvent(UserIdentityEvents.CHANGED,
        {
            detail: { previousIdentity, currentIdentity: newIdentity }
        }));

        if (!bAlreadyReady)
        {
            window.dispatchEvent(new CustomEvent(UserIdentityEvents.READY,
            {
                detail: { currentIdentity: newIdentity }
            }));
        }
    }

    /**
     * @returns {string} the current identity, defaulting to "anonymous"
     * before setIdentity() has ever been called.
     */
    static getIdentity()
    {
        return UserIdentityManager.#currentIdentity || UserIdentityConstants.ANONYMOUS_IDENTITY;
    }

    /**
     * Storage prefix for the current identity, e.g. "Users/abc123" or
     * "Users/anonymous". Used by Persistence for every namespaced path.
     */
    static getStoragePrefix()
    {
        return `${UserIdentityConstants.STORAGE_ROOT_PREFIX}/${UserIdentityManager.getIdentity()}`;
    }

    static isReady()
    {
        return UserIdentityManager.#bReady;
    }

    static isAnonymous()
    {
        return UserIdentityManager.getIdentity() === UserIdentityConstants.ANONYMOUS_IDENTITY;
    }
}

export default UserIdentityManager;
