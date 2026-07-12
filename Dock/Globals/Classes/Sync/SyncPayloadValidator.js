/**
 * SyncPayloadValidator
 *
 * Hardens the /Sync push against NoSQL-operator injection. The sync endpoint
 * threads client-supplied identifiers straight into MongoDB filters:
 *
 *   • deviceId          -> { userId, deviceId }            (sync-data upsert, lock)
 *   • change.data.id    -> { userId, "data.id": <id> }     (bulkUpsert)
 *   • change.entityId   -> { userId, entityId }            (deletion cascade)
 *
 * A well-behaved client always sends plain strings, but a hand-crafted request
 * could send an object such as `{ "$ne": null }`. Every query is already scoped
 * to the authenticated userId, so an attacker can never reach another user's
 * data — but an operator smuggled into their OWN id fields could still corrupt
 * or mass-match their own records. This validator rejects anything that is not a
 * non-empty, length-bounded primitive string BEFORE it can reach a query.
 *
 * Pure and dependency-free so it is trivially unit-testable.
 */
class SyncPayloadValidator
{
    // Ids are UUID-shaped in practice; the bound is generous but blocks an
    // absurdly long string being used to bloat a query / index probe.
    static MAX_ID_LENGTH = 512;
    static MAX_DEVICE_ID_LENGTH = 256;

    /**
     * True iff value is a safe entity id — a non-empty string within the length
     * bound. Rejects objects (operator injection), arrays, numbers, null, etc.
     */
    static isValidId(value)
    {
        return typeof value === "string" && value.length > 0 && value.length <= SyncPayloadValidator.MAX_ID_LENGTH;
    }

    /**
     * True iff value is a safe device id — a non-empty string within the bound.
     */
    static isValidDeviceId(value)
    {
        return typeof value === "string" && value.length > 0 && value.length <= SyncPayloadValidator.MAX_DEVICE_ID_LENGTH;
    }

    /**
     * Coerces a client-supplied lastSync cursor into a finite, non-negative epoch
     * millisecond number. Anything else (an object, NaN, a negative) collapses to
     * 0 so `new Date(lastSync)` can never become an Invalid Date fed into a
     * range query.
     */
    static sanitizeLastSync(value)
    {
        return Number.isFinite(value) && value >= 0 ? value : 0;
    }

    /**
     * Filters an incoming changes array to only those whose id fields are safe
     * primitive strings. A deletion change must carry a valid entityId; a
     * create/update change must carry a data object with a valid data.id.
     * Everything else is dropped.
     *
     * @param {any} changes The raw body.changes value.
     * @returns {{ validChanges: object[], droppedCount: number }}
     */
    static sanitizeChanges(changes)
    {
        const validChanges = [];
        let droppedCount = 0;

        if (!Array.isArray(changes))
        {
            return { validChanges: validChanges, droppedCount: 0 };
        }

        for (const change of changes)
        {
            if (!change || typeof change !== "object" || Array.isArray(change))
            {
                droppedCount++;
                continue;
            }

            if (change.deleted)
            {
                if (SyncPayloadValidator.isValidId(change.entityId))
                {
                    validChanges.push(change);
                }
                else
                {
                    droppedCount++;
                }
                continue;
            }

            const data = change.data;
            if (data && typeof data === "object" && !Array.isArray(data) && SyncPayloadValidator.isValidId(data.id))
            {
                validChanges.push(change);
            }
            else
            {
                droppedCount++;
            }
        }

        return { validChanges: validChanges, droppedCount: droppedCount };
    }
}

module.exports = SyncPayloadValidator;
