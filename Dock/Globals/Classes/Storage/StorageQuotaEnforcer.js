const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const PlanMetadata = require("../Plans/PlanMetadata");
const PlanTierResolver = require("../Plans/PlanTierResolver");

/**
 * StorageQuotaEnforcer
 *
 * A hard per-user cap on synced storage. The sync push previously trusted the
 * client to behave — a malicious device could push millions of fabricated
 * records and grow the database without bound. This enforcer measures a user's
 * stored document footprint and lets the push refuse further growth once the
 * cap is reached.
 *
 * The cap is the user's plan storage allowance (PlanMetadata.getStorageBytes):
 * 20 MB Free / 250 MB Basic / 500 MB Pro / 2 GB Pro Plus. LIMIT_BYTES (5 GB)
 * remains only as the fallback when the plan cannot be resolved, so a transient
 * lookup failure never wrongly blocks a legitimate sync. Deletions are always
 * allowed (they shrink the footprint); only pushes that create or update
 * entities are gated.
 *
 * The footprint is measured with MongoDB's $bsonSize aggregation (the same
 * technique StorageCreditAssessor uses) and memoised for a short window so a
 * multi-chunk sync session does not re-run the aggregation on every chunk.
 */
class StorageQuotaEnforcer
{
    // Fallback cap (5 GB, binary) used only when the user's plan tier cannot be
    // resolved. The authoritative per-user cap comes from PlanMetadata.
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
     * The user's storage allowance in bytes, resolved from their plan tier.
     * Falls back to LIMIT_BYTES when the user (and therefore the tier) cannot
     * be resolved, so a transient lookup failure never blocks a legitimate
     * sync. Lazy-requires the auth engine to avoid a require cycle.
     * @param {string} userId
     * @returns {Promise<number>}
     */
    static async getLimitBytes(userId)
    {
        try
        {
            const AuthenticationQueryEngine = require("../Database/AuthenticationQueryEngine");
            const user = await AuthenticationQueryEngine.getUserById(userId);
            if (user)
            {
                return PlanMetadata.getStorageBytes(PlanTierResolver.getEffectiveTier(user));
            }
        }
        catch (lookupError)
        {
            console.warn(`[StorageQuotaEnforcer] Plan lookup failed for ${userId}: ${lookupError?.message || lookupError}`);
        }
        return StorageQuotaEnforcer.LIMIT_BYTES;
    }

    /**
     * True iff the user is currently under their plan's storage cap (i.e. a
     * growth push may proceed).
     * @param {string} userId
     * @returns {Promise<boolean>}
     */
    static async isWithinQuota(userId)
    {
        const [usedBytes, limitBytes] = await Promise.all
        ([
            StorageQuotaEnforcer.getUsedBytes(userId),
            StorageQuotaEnforcer.getLimitBytes(userId)
        ]);
        return usedBytes < limitBytes;
    }

    /**
     * Drops the cached footprint for a user (e.g. after a large deletion) so the
     * next check re-measures rather than trusting a stale over-cap reading.
     */
    static invalidate(userId)
    {
        StorageQuotaEnforcer.#footprintCache.delete(userId);
    }

    // Collapsed into a single $unionWith pipeline (one round trip, one pool
    // checkout) instead of one aggregate() call per collection — under many
    // concurrent users this was multiplying connection-pool pressure 5x for
    // no benefit, since every collection is already indexed on userId.
    static async #computeUsedBytes(userId)
    {
        const database = await DatabaseConnector.getDatabase();
        const [firstCollectionName, ...remainingCollectionNames] = StorageQuotaEnforcer.#COUNTED_COLLECTIONS;

        const unionStages = remainingCollectionNames.map(collectionName => (
        {
            $unionWith: { coll: collectionName, pipeline: [ { $match: { userId: userId } } ] }
        }));

        const aggregationResult = await database.collection(firstCollectionName).aggregate
        ([
            { $match: { userId: userId } },
            ...unionStages,
            { $group: { _id: null, totalSize: { $sum: { $bsonSize: "$$ROOT" } } } }
        ]).toArray();

        return aggregationResult[0]?.totalSize || 0;
    }
}

module.exports = StorageQuotaEnforcer;
