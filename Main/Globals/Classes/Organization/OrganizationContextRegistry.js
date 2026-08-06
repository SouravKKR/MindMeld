import IndexedDbHelper from "../IndexedDbHelper.js";

/**
 * OrganizationContextRegistry
 *
 * The organization views this account may enter, and what each one entitles it
 * to. Populated from /GetUser at boot, which is the only authority — the client
 * never derives membership or permissions for itself, it is told them.
 *
 * The list is also written to IndexedDB, unprefixed, for two reasons. It has to
 * be readable BEFORE an identity exists (the identity is partly derived from it,
 * when a stored organization view is restored at boot), and it has to survive
 * going offline: a member who was working inside an institute's library should
 * come back to that library on a plane, not silently to their own.
 *
 * A stored entitlement is a CACHE for the interface, never an enforcement.
 * Dock re-resolves both the membership and the feature set on every request, so
 * an edited cache changes what buttons look enabled and nothing else.
 */
class OrganizationContextRegistry
{
    static #STORAGE_KEY = "organizationContexts";

    static #contexts = null;

    /**
     * Records the list /GetUser returned. Anything not an array is treated as
     * "no organizations", so a malformed or missing field degrades to the
     * personal-only experience rather than throwing during boot.
     *
     * @param {Array<object>} contexts
     */
    static async setContexts(contexts)
    {
        OrganizationContextRegistry.#contexts = Array.isArray(contexts) ? contexts : [];

        try
        {
            await IndexedDbHelper.setValue(OrganizationContextRegistry.#STORAGE_KEY, OrganizationContextRegistry.#contexts);
        }
        catch (error)
        {
            console.warn("[OrganizationContextRegistry] Failed to persist the context list:", error);
        }
    }

    /**
     * Loads the last known list from storage. Used on the offline boot path,
     * where /GetUser never answered.
     *
     * @returns {Promise<Array<object>>}
     */
    static async loadStoredContexts()
    {
        if (Array.isArray(OrganizationContextRegistry.#contexts))
        {
            return OrganizationContextRegistry.#contexts;
        }

        try
        {
            const storedValue = await IndexedDbHelper.getValue(OrganizationContextRegistry.#STORAGE_KEY);
            OrganizationContextRegistry.#contexts = Array.isArray(storedValue) ? storedValue : [];
        }
        catch (error)
        {
            console.warn("[OrganizationContextRegistry] Failed to read the stored context list:", error);
            OrganizationContextRegistry.#contexts = [];
        }

        return OrganizationContextRegistry.#contexts;
    }

    /**
     * @returns {Array<object>} the known contexts, empty before the first load.
     */
    static getContexts()
    {
        return Array.isArray(OrganizationContextRegistry.#contexts) ? OrganizationContextRegistry.#contexts : [];
    }

    /**
     * @param {string} organizationId
     * @returns {object|null}
     */
    static findContext(organizationId)
    {
        if (typeof organizationId !== "string" || organizationId.length === 0)
        {
            return null;
        }

        return OrganizationContextRegistry.getContexts().find(context => context && context.organizationId === organizationId) || null;
    }

    /**
     * The name to show for a view — falling back to the id, so a context whose
     * name has not loaded still reads as something a person can act on rather
     * than as a blank.
     *
     * @param {string} organizationId
     * @returns {string}
     */
    static getOrganizationName(organizationId)
    {
        const context = OrganizationContextRegistry.findContext(organizationId);
        return context && typeof context.organizationName === "string" && context.organizationName.length > 0
            ? context.organizationName
            : organizationId;
    }

    /**
     * Whether a feature is granted inside one organization's view. Used to grey
     * out what the institute has not provided; the server decides for real.
     *
     * @param {string} organizationId
     * @param {number} featureValue a PlanFeatures value
     * @returns {boolean}
     */
    static isFeatureAllowedInContext(organizationId, featureValue)
    {
        const context = OrganizationContextRegistry.findContext(organizationId);
        if (!context || !Array.isArray(context.allowedFeatures))
        {
            return false;
        }

        return context.allowedFeatures.includes(featureValue);
    }

    /**
     * Clears everything on logout, so the next account never sees the previous
     * one's institutes in the switcher.
     */
    static async clear()
    {
        OrganizationContextRegistry.#contexts = [];

        try
        {
            await IndexedDbHelper.setValue(OrganizationContextRegistry.#STORAGE_KEY, []);
        }
        catch (error)
        {
            console.warn("[OrganizationContextRegistry] Failed to clear the stored context list:", error);
        }
    }
}

export default OrganizationContextRegistry;
