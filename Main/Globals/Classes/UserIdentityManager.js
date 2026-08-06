import IndexedDbHelper from "./IndexedDbHelper.js";
import UserIdentityConstants from "../Constants/UserIdentityConstants.js";
import UserIdentityEvents from "../Events/UserIdentityEvents.js";
import OrganizationContextIdentity from "./Organization/OrganizationContextIdentity.js";

/**
 * UserIdentityManager
 *
 * Single source of truth for the currently active storage identity.
 * - For a logged-in user, identity is the user's id (e.g. Google sub).
 * - For an unauthenticated user, identity is "anonymous".
 * - Inside an organization view, identity is `<userId>::org:<organizationId>` —
 *   a DIFFERENT namespace, not the personal one filtered. Personal decks are
 *   therefore absent from memory rather than hidden, which is what makes a leak
 *   between the two libraries structurally impossible.
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

    // The organization view to restore at the next boot. Kept OUTSIDE the
    // per-identity prefix on purpose: it is read before any identity is known,
    // exactly like the offline session cache.
    static #ORGANIZATION_CONTEXT_STORAGE_KEY = "currentOrganizationContextId";

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
     * Switches between the personal view and an organization's.
     *
     * Goes through setIdentity, so the whole app reacts to a view change the
     * same way it reacts to a login: Deck wipes memory and re-boots from this
     * namespace's root, and Persistence starts reading and writing under the
     * new prefix. Nothing has to know a view change is a different thing from a
     * user change, because it is not.
     *
     * @param {string} userId the account, which never changes with the view
     * @param {string} organizationId "" for the personal view
     */
    static async setOrganizationContext(userId, organizationId)
    {
        const contextId = typeof organizationId === "string" ? organizationId : "";

        try
        {
            await IndexedDbHelper.setValue(UserIdentityManager.#ORGANIZATION_CONTEXT_STORAGE_KEY, contextId);
        }
        catch (error)
        {
            console.error("[UserIdentityManager] Failed to persist the organization context:", error);
        }

        await UserIdentityManager.setIdentity(OrganizationContextIdentity.compose(userId, contextId));
    }

    /**
     * The organization view stored at the last switch, so a reload comes back to
     * the library the user was looking at rather than silently to their own.
     *
     * @returns {Promise<string>} "" when the personal view was last active
     */
    static async readStoredOrganizationContextId()
    {
        try
        {
            const storedValue = await IndexedDbHelper.getValue(UserIdentityManager.#ORGANIZATION_CONTEXT_STORAGE_KEY);
            return typeof storedValue === "string" ? storedValue : "";
        }
        catch (error)
        {
            console.warn("[UserIdentityManager] Failed to read the stored organization context:", error);
            return "";
        }
    }

    /**
     * The account id, whichever view is active. Anything that identifies the
     * PERSON — their plan, their credit balance, their profile — must use this
     * rather than getIdentity(), which names a library.
     *
     * @returns {string}
     */
    static getUserId()
    {
        return OrganizationContextIdentity.extractUserId(UserIdentityManager.getIdentity());
    }

    /**
     * The organization whose view is active, or "" for the personal view.
     *
     * @returns {string}
     */
    static getOrganizationContextId()
    {
        return OrganizationContextIdentity.extractOrganizationId(UserIdentityManager.getIdentity());
    }

    /**
     * True while an organization's library is the one on screen.
     */
    static isOrganizationContext()
    {
        return UserIdentityManager.getOrganizationContextId().length > 0;
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
