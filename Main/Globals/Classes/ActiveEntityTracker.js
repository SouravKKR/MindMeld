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
 * under the user's feet. That overlay exists to protect an *editor's*
 * in-memory reference from being overwritten before the user's save(), so
 * it must only fire when the entity is actually being edited. Read-only
 * study / viewing sessions register the entity with bEditing=false so a
 * minor incremental pull doesn't interrupt studying with a blocking modal.
 */
class ActiveEntityTracker
{
    static #activeEntityId = null;
    static #activeEntityType = null;
    static #bEditing = false;

    /**
     * Marks the given entity as the user's current focus.
     * Subsequent calls overwrite the previous tracked entity.
     * @param {string} entityId - Entity id (uuid).
     * @param {number} entityType - One of entityTypes.* enum values.
     * @param {boolean} bEditing - True when the entity is open in an editor
     *     (the user may have unsaved edits). Read-only study / viewing
     *     contexts leave this false so they don't raise the blocking overlay.
     */
    static set(entityId, entityType, bEditing = false)
    {
        if (!entityId)
        {
            ActiveEntityTracker.clear();
            return;
        }

        ActiveEntityTracker.#activeEntityId = entityId;
        ActiveEntityTracker.#activeEntityType = entityType;
        ActiveEntityTracker.#bEditing = bEditing === true;
    }

    static clear()
    {
        ActiveEntityTracker.#activeEntityId = null;
        ActiveEntityTracker.#activeEntityType = null;
        ActiveEntityTracker.#bEditing = false;
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
     * True when the active entity is open in an editor (and may carry
     * unsaved edits). The sync layer uses this to decide whether a pull
     * touching the active entity should raise the blocking overlay.
     * @returns {boolean}
     */
    static isEditing()
    {
        return ActiveEntityTracker.#bEditing;
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
