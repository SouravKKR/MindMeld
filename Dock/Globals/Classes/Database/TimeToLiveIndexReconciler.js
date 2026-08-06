/**
 * TimeToLiveIndexReconciler
 *
 * Creates a TTL index, or updates the expiry of one that already exists.
 *
 * ── The trap this exists to close ─────────────────────────────────────────
 *
 * `createIndex({ createdAt: 1 }, { expireAfterSeconds: N })` is idempotent only
 * while N never changes. Point it at the same keys with a DIFFERENT
 * expireAfterSeconds and MongoDB does not update the index — it raises
 * IndexOptionsConflict (code 85). Every caller in this codebase wraps index
 * creation in a try/catch that logs and continues, which is correct for a
 * transient failure and quietly wrong here: the retention change appears in the
 * source, passes review, deploys cleanly, logs one line nobody reads, and the
 * old expiry stays in force forever.
 *
 * That failure mode is particularly bad for a retention increase, because the
 * symptom is data still being deleted early — which looks like the TTL working,
 * not like a bug.
 *
 * Changing the expiry of an existing TTL index requires `collMod`. So: try to
 * create, and on a conflict fall back to modifying. A fresh database takes the
 * first path, an existing deployment takes the second, and both end up with the
 * expiry the source asks for.
 */
class TimeToLiveIndexReconciler
{
    // MongoDB's error code for "an index with these keys already exists with
    // different options".
    static INDEX_OPTIONS_CONFLICT_ERROR_CODE = 85;

    /**
     * Ensures a TTL index over `keyPattern` expires after `expireAfterSeconds`,
     * creating it or amending it as needed.
     *
     * Returns what it did rather than throwing, because index maintenance runs
     * on the first query of a collection and must never fail the request that
     * triggered it.
     *
     * @param {object} database — the Mongo database handle
     * @param {string} collectionName
     * @param {object} keyPattern — e.g. { createdAt: 1 }
     * @param {number} expireAfterSeconds
     * @returns {Promise<{ensured: boolean, action: string, reason?: string}>}
     */
    static async ensure(database, collectionName, keyPattern, expireAfterSeconds)
    {
        if (!database || typeof collectionName !== "string" || collectionName.length === 0)
        {
            return { ensured: false, action: "NONE", reason: "NO_DATABASE" };
        }

        try
        {
            await database.collection(collectionName).createIndex(keyPattern, { expireAfterSeconds: expireAfterSeconds });
            return { ensured: true, action: "CREATED" };
        }
        catch (createError)
        {
            if (createError?.code !== TimeToLiveIndexReconciler.INDEX_OPTIONS_CONFLICT_ERROR_CODE)
            {
                console.error(`[TimeToLiveIndexReconciler] Failed to create the TTL index on ${collectionName}:`, createError);
                return { ensured: false, action: "NONE", reason: "CREATE_FAILED" };
            }
        }

        // The index exists with a different expiry. collMod is the only way to
        // change it in place; dropping and recreating would leave the
        // collection briefly un-expired and is needless risk on a live system.
        try
        {
            await database.command
            ({
                collMod: collectionName,
                index: { keyPattern: keyPattern, expireAfterSeconds: expireAfterSeconds }
            });
            console.warn(`[TimeToLiveIndexReconciler] Updated the TTL on ${collectionName} to ${expireAfterSeconds} seconds.`);
            return { ensured: true, action: "MODIFIED" };
        }
        catch (modifyError)
        {
            // Worth an error rather than a warning: the retention the source
            // asks for is NOT in force, and nothing else will say so.
            console.error(`[TimeToLiveIndexReconciler] The TTL on ${collectionName} could not be updated to ${expireAfterSeconds} seconds; the previous expiry is still in force:`, modifyError);
            return { ensured: false, action: "NONE", reason: "MODIFY_FAILED" };
        }
    }
}

module.exports = TimeToLiveIndexReconciler;
