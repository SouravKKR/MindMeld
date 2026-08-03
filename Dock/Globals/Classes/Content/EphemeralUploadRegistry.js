const crypto = require("crypto");
const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const Persistence = require("../Persistence");
const { storageTargets } = require("../../Enumerations/StorageTargets");

/**
 * EphemeralUploadRegistry — the deletion record for user files that are NOT
 * information sources.
 *
 * Uploaded study documents have their own lifecycle (SourceRetentionPolicy +
 * ExpiredInformationSourceReaper). Everything else a user uploads — scanned
 * answer sheets, support-ticket attachments — previously had none: the bytes
 * were written to object storage and nothing ever removed them. This registry
 * is the missing half. A producer records "these objects exist, under this
 * prefix, and must be gone by this time"; the reaper reads that and deletes
 * them.
 *
 * Why a registry row rather than a storage-side TTL. Object storage has no
 * expiry primitive here, and a Mongo TTL index on the owning document would be
 * worse than nothing: it would drop the row that records WHERE the blobs live,
 * leaving them unreachable and therefore permanently undeletable. This is the
 * same reasoning that made ExpiredInformationSourceReaper a real sweep rather
 * than a TTL index, and it applies unchanged here.
 *
 * Deletion is by PREFIX, not by a stored file list. A transcription writes N
 * scan blobs plus a request manifest, and a partially-written batch must still
 * be fully reclaimable — listing the prefix at sweep time collects whatever is
 * actually there, including files a crash left behind mid-write.
 *
 * The row is deleted only AFTER the objects are gone, so a crash mid-sweep
 * leaves the row in place and the next tick retries. The failure mode is
 * "sweep again", never "forget".
 */
class EphemeralUploadRegistry
{
    /**
     * Records a set of uploaded objects for later deletion.
     *
     * Best-effort by design: a registration failure must not fail the user
     * action that produced the upload. It is logged loudly because the
     * consequence is a blob nobody will reclaim — the orphan sweep below is
     * what limits that damage.
     *
     * @param {object} registrationDetails
     * @param {string} registrationDetails.storagePrefix Prefix every object sits under.
     * @param {number} registrationDetails.kind An ephemeralUploadKinds value.
     * @param {string|null} registrationDetails.userId Owner, for erasure requests.
     * @param {number} registrationDetails.retentionDays Days to keep before deletion.
     * @param {object} [registrationDetails.metadata] Anything the sweeper or an admin may need.
     * @return {Promise<boolean>} True when the record was written.
     */
    static async register(registrationDetails)
    {
        if (typeof registrationDetails?.storagePrefix !== "string" || registrationDetails.storagePrefix.length === 0)
        {
            return false;
        }

        const retentionMilliseconds = registrationDetails.retentionDays * 24 * 60 * 60 * 1000;

        try
        {
            const collection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.EPHEMERAL_UPLOADS_COLLECTION);

            await collection.updateOne
            (
                { storagePrefix: registrationDetails.storagePrefix },
                {
                    $set:
                    {
                        kind: registrationDetails.kind,
                        userId: registrationDetails.userId || null,
                        expiresAt: Date.now() + retentionMilliseconds,
                        metadata: registrationDetails.metadata || {}
                    },
                    $setOnInsert:
                    {
                        id: crypto.randomUUID(),
                        storagePrefix: registrationDetails.storagePrefix,
                        registeredAt: Date.now()
                    }
                },
                { upsert: true },
            );

            return true;
        }
        catch (registrationError)
        {
            console.error(
                `[EphemeralUploadRegistry] Could not register ${registrationDetails.storagePrefix} for deletion: ` +
                `${registrationError?.message || registrationError}`,
            );
            return false;
        }
    }

    /**
     * Deletes every object under a registered prefix and then drops the record.
     *
     * Called both by the reaper (expiry reached) and directly by a producer that
     * knows the files are no longer needed — a resolved support ticket does not
     * have to wait out its retention window.
     *
     * @param {string} storagePrefix
     * @return {Promise<number>} Objects removed.
     */
    static async purgePrefix(storagePrefix)
    {
        if (typeof storagePrefix !== "string" || storagePrefix.length === 0)
        {
            return 0;
        }

        let objectPaths = [];
        try
        {
            objectPaths = await Persistence.list(storagePrefix, storageTargets.LINODE_OBJECT_STORAGE);
        }
        catch (listError)
        {
            // A prefix that cannot be listed may still have a row to clear (the
            // objects may already be gone). Fall through to the row delete
            // rather than stalling this prefix forever.
            console.warn(`[EphemeralUploadRegistry] Could not list ${storagePrefix}: ${listError?.message || listError}`);
        }

        let removedCount = 0;
        for (const objectPath of objectPaths)
        {
            try
            {
                await Persistence.delete(objectPath, storageTargets.LINODE_OBJECT_STORAGE);
                removedCount++;
            }
            catch (deleteError)
            {
                // Leave the row in place so the next sweep retries this prefix.
                console.warn(`[EphemeralUploadRegistry] Could not delete ${objectPath}: ${deleteError?.message || deleteError}`);
                return removedCount;
            }
        }

        try
        {
            const collection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.EPHEMERAL_UPLOADS_COLLECTION);
            await collection.deleteOne({ storagePrefix: storagePrefix });
        }
        catch (rowError)
        {
            console.warn(`[EphemeralUploadRegistry] Objects removed but the record for ${storagePrefix} survives: ${rowError?.message || rowError}`);
        }

        return removedCount;
    }

    /**
     * Returns the prefixes whose retention window has elapsed.
     *
     * @param {number} nowMilliseconds
     * @param {number} maximumRecords Bound on work per sweep.
     * @return {Promise<Array<{storagePrefix: string, kind: number, userId: (string|null)}>>}
     */
    static async findDue(nowMilliseconds, maximumRecords)
    {
        const collection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.EPHEMERAL_UPLOADS_COLLECTION);

        return await collection
            .find({ expiresAt: { $lte: nowMilliseconds } }, { projection: { _id: 0, storagePrefix: 1, kind: 1, userId: 1 } })
            .limit(maximumRecords)
            .toArray();
    }

    /**
     * Removes every registered upload belonging to one user, immediately.
     *
     * Account deletion must not leave a user's scanned handwriting or support
     * screenshots sitting out the remainder of a retention window — erasure
     * means now, not eventually.
     *
     * @param {string} userId
     * @return {Promise<number>} Prefixes purged.
     */
    static async purgeAllForUser(userId)
    {
        const collection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.EPHEMERAL_UPLOADS_COLLECTION);

        const userRecords = await collection
            .find({ userId: userId }, { projection: { _id: 0, storagePrefix: 1 } })
            .toArray();

        let purgedCount = 0;
        for (const userRecord of userRecords)
        {
            await EphemeralUploadRegistry.purgePrefix(userRecord.storagePrefix);
            purgedCount++;
        }

        return purgedCount;
    }
}

module.exports = EphemeralUploadRegistry;
