/**
 * ActiveEntityTracker
 *
 * Holds a single weak reference to the entity the user is currently engaged
 * with — the card being studied, the deck being edited, the study material
 * being authored, etc. Pages call set(...) when they take focus and clear()
 * when they release it (or PageNavigator clears it on every navigation).
 *
 * SyncManager queries this before applying server-side pulls so it can put
 * up a blocking overlay whenever the active entity is about to be mutated
 * under the user's feet.
 */
class ActiveEntityTracker
{
    static #activeEntityId   = null;
    static #activeEntityType = null;

    /**
     * Marks the given entity as the user's current focus.
     * Subsequent calls overwrite the previous tracked entity.
     * @param {string} entityId - Entity id (uuid).
     * @param {number} entityType - One of entityTypes.* enum values.
     */
    static set(entityId, entityType)
    {
        if (!entityId)
        {
            ActiveEntityTracker.clear();
            return;
        }

        ActiveEntityTracker.#activeEntityId   = entityId;
        ActiveEntityTracker.#activeEntityType = entityType;
    }

    static clear()
    {
        ActiveEntityTracker.#activeEntityId   = null;
        ActiveEntityTracker.#activeEntityType = null;
    }

    static getId()
    {
        return ActiveEntityTracker.#activeEntityId;
    }

    static getType()
    {
        return ActiveEntityTracker.#activeEntityType;
    }

    /**
     * Exact match: same id and same entity type.
     * @param {string} entityId
     * @param {number} entityType
     * @returns {boolean}
     */
    static matches(entityId, entityType)
    {
        return ActiveEntityTracker.#activeEntityId === entityId
            && ActiveEntityTracker.#activeEntityType === entityType;
    }
}

export default ActiveEntityTracker;
