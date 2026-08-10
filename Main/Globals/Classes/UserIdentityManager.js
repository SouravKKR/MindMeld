import IndexedDbHelper from "./IndexedDbHelper.js";
import UserIdentityConstants from "../Constants/UserIdentityConstants.js";
import UserIdentityEvents from "../Events/UserIdentityEvents.js";
import ViewIdentity from "./View/ViewIdentity.js";
import { userViewKinds } from "../Enumerations/UserViewKinds.js";

/**
 * UserIdentityManager
 *
 * Single source of truth for the currently active storage identity.
 * - For a logged-in user, identity is the user's id (e.g. Google sub).
 * - For an unauthenticated user, identity is "anonymous".
 * - Inside an organization view, identity is `<userId>::org:<organizationId>`.
 * - Inside an administrator's simulated plan view, identity is
 *   `<userId>::plan:<PLAN_TIER_NAME>`.
 *
 * Each of those is a DIFFERENT namespace, not the personal one filtered.
 * Another library's decks are therefore absent from memory rather than hidden,
 * which is what makes a leak between them structurally impossible.
 *
 * Storage paths used by Persistence are namespaced under
 * `Users/<identity>/...`, which gives logged-in users isolated data,
 * keeps anonymous data separate from any account, and prevents the
 * "logout → login → ghost entities" bug where the previous user's
 * data leaks into the new user's session.
 *
 * ONE stored view record, not one key per kind. The views are mutually
 * exclusive, and a single `{ kind, value }` record makes that structural: there
 * is no state in which both are set, so no precedence rule has to be invented
 * and no two writes have to be ordered correctly. The legacy
 * `currentOrganizationContextId` key is still READ as a fallback, or every
 * install currently sitting in an organization view would land in their personal
 * library once, silently, on the release that introduced this.
 *
 * ESCAPE HATCH. Loading `/index.html?view=personal` forces the personal view and
 * erases the stored record before anything reads it. A view replaces the entire
 * library, so a view that will not load is a user who cannot reach the menu that
 * would let them leave it — and the in-app exits (the indicator on every page,
 * the profile menu) all assume the app rendered. This one does not. It is
 * checked here rather than at a call site so that every path which restores a
 * view honours it, and `/index.html` rather than `/` because the bare root plus
 * a query string does not survive the server's path normalisation.
 *
 * Persists its own current value to IndexedDbHelper directly (NOT
 * Persistence — Persistence depends on this class). Reading is
 * synchronous after boot; the setters are async only because of the
 * underlying IndexedDB write.
 */
class UserIdentityManager
{
    static #IDENTITY_STORAGE_KEY = "currentUserIdentity";

    // The view to restore at the next boot, as { kind, value }. Kept OUTSIDE the
    // per-identity prefix on purpose: it is read before any identity is known,
    // exactly like the offline session cache.
    static #VIEW_CONTEXT_STORAGE_KEY = "currentViewContext";

    // Superseded by the record above. Read-only, and only when the new record is
    // absent — see the note about the upgrade in the class comment.
    static #LEGACY_ORGANIZATION_CONTEXT_STORAGE_KEY = "currentOrganizationContextId";

    static #ESCAPE_HATCH_QUERY_PARAMETER = "view";
    static #ESCAPE_HATCH_PERSONAL_VALUE = "personal";

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
     * Switches the active view.
     *
     * Goes through setIdentity, so the whole app reacts to a view change the
     * same way it reacts to a login: Deck wipes memory and re-boots from this
     * namespace's root, and Persistence starts reading and writing under the
     * new prefix. Nothing has to know a view change is a different thing from a
     * user change, because it is not.
     *
     * @param {string} userId the account, which never changes with the view
     * @param {number} viewKind a userViewKinds value
     * @param {string} viewValue the organization id or the plan tier name
     */
    static async #setViewContext(userId, viewKind, viewValue)
    {
        const storedRecord = { kind: viewKind, value: typeof viewValue === "string" ? viewValue : "" };

        try
        {
            await IndexedDbHelper.setValue(UserIdentityManager.#VIEW_CONTEXT_STORAGE_KEY, storedRecord);
        }
        catch (error)
        {
            console.error("[UserIdentityManager] Failed to persist the view context:", error);
        }

        if (viewKind === userViewKinds.ORGANIZATION)
        {
            await UserIdentityManager.setIdentity(ViewIdentity.composeOrganization(userId, storedRecord.value));
            return;
        }

        if (viewKind === userViewKinds.PLAN)
        {
            await UserIdentityManager.setIdentity(ViewIdentity.composePlan(userId, storedRecord.value));
            return;
        }

        await UserIdentityManager.setIdentity(userId);
    }

    /**
     * Switches between the personal view and an organization's. A blank
     * organization id means the personal view, so a caller can pass whatever it
     * has without branching first.
     *
     * @param {string} userId
     * @param {string} organizationId "" for the personal view
     */
    static async setOrganizationContext(userId, organizationId)
    {
        const contextId = typeof organizationId === "string" ? organizationId : "";

        await UserIdentityManager.#setViewContext(
            userId,
            contextId.length > 0 ? userViewKinds.ORGANIZATION : userViewKinds.PERSONAL,
            contextId,
        );
    }

    /**
     * Switches between the personal view and an administrator's simulated plan
     * sandbox. A blank or unknown tier name means the personal view — an
     * unrecognised tier is a malformed request, and the personal library is the
     * only safe place to land.
     *
     * @param {string} userId
     * @param {string} planTierName "" for the personal view
     */
    static async setPlanViewContext(userId, planTierName)
    {
        const bKnownTier = ViewIdentity.isKnownPlanTierName(planTierName);

        await UserIdentityManager.#setViewContext(
            userId,
            bKnownTier ? userViewKinds.PLAN : userViewKinds.PERSONAL,
            bKnownTier ? planTierName : "",
        );
    }

    /**
     * Returns to the personal library from whichever view is active. Used by
     * logout, where the account itself is changing, and by the exits.
     *
     * @param {string} userId
     */
    static async clearViewContext(userId)
    {
        await UserIdentityManager.#setViewContext(userId, userViewKinds.PERSONAL, "");
    }

    /**
     * The view stored at the last switch, so a reload comes back to the library
     * the user was looking at rather than silently to their own.
     *
     * Honours the `?view=personal` escape hatch before anything else, and erases
     * the stored record when it fires so the next reload — without the
     * parameter — stays personal rather than falling back into a view that could
     * not be left.
     *
     * @returns {Promise<{kind: number, value: string}>}
     */
    static async readStoredViewContext()
    {
        const personalView = { kind: userViewKinds.PERSONAL, value: "" };

        if (UserIdentityManager.#isPersonalViewForcedByUrl())
        {
            console.warn("[UserIdentityManager] ?view=personal was requested — clearing the stored view.");

            try
            {
                await IndexedDbHelper.setValue(UserIdentityManager.#VIEW_CONTEXT_STORAGE_KEY, personalView);
                await IndexedDbHelper.setValue(UserIdentityManager.#LEGACY_ORGANIZATION_CONTEXT_STORAGE_KEY, "");
            }
            catch (error)
            {
                console.error("[UserIdentityManager] Failed to clear the stored view:", error);
            }

            return personalView;
        }

        try
        {
            const storedRecord = await IndexedDbHelper.getValue(UserIdentityManager.#VIEW_CONTEXT_STORAGE_KEY);

            if (storedRecord && typeof storedRecord === "object" && typeof storedRecord.kind === "number")
            {
                return { kind: storedRecord.kind, value: typeof storedRecord.value === "string" ? storedRecord.value : "" };
            }

            const legacyOrganizationId = await IndexedDbHelper.getValue(UserIdentityManager.#LEGACY_ORGANIZATION_CONTEXT_STORAGE_KEY);

            if (typeof legacyOrganizationId === "string" && legacyOrganizationId.length > 0)
            {
                return { kind: userViewKinds.ORGANIZATION, value: legacyOrganizationId };
            }
        }
        catch (error)
        {
            console.warn("[UserIdentityManager] Failed to read the stored view context:", error);
        }

        return personalView;
    }

    /**
     * The organization view stored at the last switch, or "" when the last
     * active view was not an organization's.
     *
     * @returns {Promise<string>}
     */
    static async readStoredOrganizationContextId()
    {
        const storedView = await UserIdentityManager.readStoredViewContext();
        return storedView.kind === userViewKinds.ORGANIZATION ? storedView.value : "";
    }

    static #isPersonalViewForcedByUrl()
    {
        try
        {
            const requestedView = new URLSearchParams(window.location.search).get(UserIdentityManager.#ESCAPE_HATCH_QUERY_PARAMETER);
            return String(requestedView || "").toLowerCase() === UserIdentityManager.#ESCAPE_HATCH_PERSONAL_VALUE;
        }
        catch (error)
        {
            // An unparseable location must never be the thing that stops a user
            // signing in, and "not requested" is the harmless answer.
            return false;
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
        return ViewIdentity.extractUserId(UserIdentityManager.getIdentity());
    }

    /**
     * The organization whose view is active, or "" for any other view.
     *
     * @returns {string}
     */
    static getOrganizationContextId()
    {
        return ViewIdentity.extractOrganizationId(UserIdentityManager.getIdentity());
    }

    /**
     * The plan tier being simulated, or "" for any other view.
     *
     * @returns {string}
     */
    static getPlanViewTierName()
    {
        return ViewIdentity.extractPlanTierName(UserIdentityManager.getIdentity());
    }

    /**
     * True while an organization's library is the one on screen.
     */
    static isOrganizationContext()
    {
        return UserIdentityManager.getOrganizationContextId().length > 0;
    }

    /**
     * True while a simulated plan sandbox is the one on screen.
     */
    static isPlanViewContext()
    {
        return UserIdentityManager.getPlanViewTierName().length > 0;
    }

    /**
     * True while the user's own library is the one on screen.
     */
    static isPersonalView()
    {
        return ViewIdentity.isPersonalIdentity(UserIdentityManager.getIdentity());
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
