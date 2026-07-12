const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");

/**
 * StorageQuotaEnforcer
 *
 * A hard per-user cap on synced storage. The sync push previously trusted the
 * client to behave — a malicious device could push millions of fabricated
 * records and grow the database without bound. This enforcer measures a user's
 * stored document footprint and lets the push refuse further growth once the
 * cap is reached.
 *
 * The cap is a single flat 5 GB for now; tier-based limits will layer on later.
 * Deletions are always allowed (they shrink the footprint); only pushes that
 * create or update entities are gated.
 *
 * The footprint is measured with MongoDB's $bsonSize aggregation (the same
 * technique StorageCreditAssessor uses) and memoised for a short window so a
 * multi-chunk sync session does not re-run the aggregation on every chunk.
 */
class StorageQuotaEnforcer
{
    // 5 GB hard limit per user (binary gigabytes).
    static LIMIT_BYTES = 5 * 1024 * 1024 * 1024;

    static #CACHE_TTL_MILLISECONDS = 30 * 1000;

    // userId -> { bytes, measuredAtMilliseconds }. A short TTL bounds both the
    // over-admit window (a user just under the cap) and the rescan cost when a
    // client hammers the endpoint after being rejected.
    static #footprintCache = new Map();

    static #COUNTED_COLLECTIONS =
    [
        DatabaseConstants.DECKS_COLLECTION,
        DatabaseConstants.CARDS_COLLECTION,
        DatabaseConstants.STUDY_MATERIALS_COLLECTION,
        DatabaseConstants.MOCK_TESTS_COLLECTION,
        DatabaseConstants.ASK_AI_POPUP_LINKS_COLLECTION
    ];

    /**
     * Returns the user's current stored footprint in bytes, using a cached value
     * when it is still fresh.
     * @param {string} userId
     * @param {boolean} [forceFresh] Skip the cache and re-measure.
     * @returns {Promise<number>}
     */
    static async getUsedBytes(userId, forceFresh = false)
    {
        const nowMilliseconds = Date.now();
        const cached = StorageQuotaEnforcer.#footprintCache.get(userId);
        if (!forceFresh && cached && (nowMilliseconds - cached.measuredAtMilliseconds) < StorageQuotaEnforcer.#CACHE_TTL_MILLISECONDS)
        {
            return cached.bytes;
        }

        const bytes = await StorageQuotaEnforcer.#computeUsedBytes(userId);
        StorageQuotaEnforcer.#footprintCache.set(userId, { bytes: bytes, measuredAtMilliseconds: nowMilliseconds });
        return bytes;
    }

    /**
     * True iff the user is currently under the storage cap (i.e. a growth push
     * may proceed).
     * @param {string} userId
     * @returns {Promise<boolean>}
     */
    static async isWithinQuota(userId)
    {
        const usedBytes = await StorageQuotaEnforcer.getUsedBytes(userId);
        return usedBytes < StorageQuotaEnforcer.LIMIT_BYTES;
    }

    /**
     * Drops the cached footprint for a user (e.g. after a large deletion) so the
     * next check re-measures rather than trusting a stale over-cap reading.
     */
    static invalidate(userId)
    {
        StorageQuotaEnforcer.#footprintCache.delete(userId);
    }

    static async #computeUsedBytes(userId)
    {
        const database = await DatabaseConnector.getDatabase();
        let totalBytes = 0;

        for (const collectionName of StorageQuotaEnforcer.#COUNTED_COLLECTIONS)
        {
            const aggregationResult = await database.collection(collectionName).aggregate
            ([
                { $match: { userId: userId } },
                { $group: { _id: null, totalSize: { $sum: { $bsonSize: "$$ROOT" } } } }
            ]).toArray();
            totalBytes += aggregationResult[0]?.totalSize || 0;
        }

        return totalBytes;
    }
}

module.exports = StorageQuotaEnforcer;
