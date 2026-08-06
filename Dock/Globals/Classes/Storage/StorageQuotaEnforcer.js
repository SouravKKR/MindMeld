const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const PlanMetadata = require("../Plans/PlanMetadata");
const PlanTierResolver = require("../Plans/PlanTierResolver");
const { contentRetentionModes } = require("../../Enumerations/ContentRetentionModes");

/**
 * StorageQuotaEnforcer
 *
 * A hard per-user cap on total stored storage. The sync push previously trusted
 * the client to behave — a malicious device could push millions of fabricated
 * records and grow the database without bound. This enforcer measures a user's
 * combined stored footprint and lets the push refuse further growth once the
 * cap is reached.
 *
 * The footprint is the sum of two categories, mirroring how storage billing
 * splits them (see StorageCreditAssessor):
 *   • DECKS — the BSON document footprint of the synced content collections
 *     (decks / cards / study materials / mock tests / ask-ai links).
 *   • UPLOADS — the stored file size of the user's PERMANENT information-source
 *     blobs in object storage (InformationSource.fileSizeBytes).
 * Both count against the single plan cap, so the number this enforcer guards is
 * the same total the Settings storage meter shows the user.
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

    // userId -> { decksBytes, uploadsBytes, totalBytes, measuredAtMilliseconds }.
    // A short TTL bounds both the over-admit window (a user just under the cap)
    // and the rescan cost when a client hammers the endpoint after being
    // rejected.
    static #footprintCache = new Map();

    static #COUNTED_COLLECTIONS =
    [
        DatabaseConstants.DECKS_COLLECTION,
        DatabaseConstants.CARDS_COLLECTION,
        DatabaseConstants.STUDY_MATERIALS_COLLECTION,
        DatabaseConstants.MOCK_TESTS_COLLECTION,
        DatabaseConstants.ASK_AI_POPUP_LINKS_COLLECTION,
        DatabaseConstants.CONTENT_OVERLAYS_COLLECTION
    ];

    /**
     * Returns the user's stored footprint split into its two categories plus the
     * total, using a cached value when it is still fresh.
     * @param {string} userId
     * @param {boolean} [forceFresh] Skip the cache and re-measure.
     * @returns {Promise<{ decksBytes: number, uploadsBytes: number, totalBytes: number }>}
     */
    static async #getBreakdown(userId, forceFresh = false)
    {
        const nowMilliseconds = Date.now();
        const cached = StorageQuotaEnforcer.#footprintCache.get(userId);
        if (!forceFresh && cached && (nowMilliseconds - cached.measuredAtMilliseconds) < StorageQuotaEnforcer.#CACHE_TTL_MILLISECONDS)
        {
            return { decksBytes: cached.decksBytes, uploadsBytes: cached.uploadsBytes, totalBytes: cached.totalBytes };
        }

        const breakdown = await StorageQuotaEnforcer.#computeBreakdown(userId);
        StorageQuotaEnforcer.#footprintCache.set(userId, { ...breakdown, measuredAtMilliseconds: nowMilliseconds });
        return breakdown;
    }

    /**
     * Returns the user's current total stored footprint in bytes (decks +
     * uploads), using a cached value when it is still fresh.
     * @param {string} userId
     * @param {boolean} [forceFresh] Skip the cache and re-measure.
     * @returns {Promise<number>}
     */
    static async getUsedBytes(userId, forceFresh = false)
    {
        return (await StorageQuotaEnforcer.#getBreakdown(userId, forceFresh)).totalBytes;
    }

    /**
     * The full storage picture for a user, ready to show in the UI: the two
     * category totals, their combined total, and the plan cap they are measured
     * against. Never throws for a resolvable user; callers that surface this to
     * the client should still guard against a transient database failure.
     * @param {string} userId
     * @param {boolean} [forceFresh] Skip the cache and re-measure.
     * @returns {Promise<{ decksBytes: number, uploadsBytes: number, totalBytes: number, limitBytes: number }>}
     */
    static async getUsageBreakdown(userId, forceFresh = false)
    {
        const [breakdown, limitBytes] = await Promise.all
        ([
            StorageQuotaEnforcer.#getBreakdown(userId, forceFresh),
            StorageQuotaEnforcer.getLimitBytes(userId)
        ]);
        return { ...breakdown, limitBytes: limitBytes };
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
                const planStorageBytes = PlanMetadata.getStorageBytes(PlanTierResolver.getEffectiveTier(user));

                // Organizations can grant their members extra space, because an
                // institute pushing a large deck library at a Free account would
                // otherwise exhaust a 20 MB cap on day one. The grant RAISES the
                // user's single allowance rather than creating a second budget:
                // one number to reason about, and storage still belongs to the
                // person rather than to a view.
                const OrganizationScopeResolver = require("../Organization/OrganizationScopeResolver");
                const OrganizationFeatureResolver = require("../Organization/OrganizationFeatureResolver");

                const scope = await OrganizationScopeResolver.listAllScopeKeysForUser(user);
                const grantedBytes = await OrganizationFeatureResolver.resolveTotalStorageGrantBytes
                (
                    scope.organizations,
                    userId,
                    user.getAdditionalData()?.email || ""
                );

                return planStorageBytes + grantedBytes;
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
     * The pure at-the-cap decision, factored out so it can be unit-tested
     * without a database: true iff a footprint of `usedBytes` plus a further
     * `additionalBytes` stays at or under `limitBytes`. A negative or non-finite
     * addition is treated as zero so a bad file-size reading can never wrongly
     * admit growth.
     * @param {number} usedBytes
     * @param {number} additionalBytes
     * @param {number} limitBytes
     * @returns {boolean}
     */
    static fitsWithinLimit(usedBytes, additionalBytes, limitBytes)
    {
        const safeUsed = Number(usedBytes) || 0;
        const safeAdditional = Math.max(0, Number(additionalBytes) || 0);
        return (safeUsed + safeAdditional) <= Number(limitBytes);
    }

    /**
     * True iff adding `additionalBytes` to the user's current footprint would
     * still leave them at or under their plan cap. Used by the upload endpoint
     * to refuse a file that would push the combined (decks + uploads) footprint
     * over the cap before the blob is stored.
     * @param {string} userId
     * @param {number} additionalBytes
     * @returns {Promise<boolean>}
     */
    static async wouldFitWithinQuota(userId, additionalBytes = 0)
    {
        const [usedBytes, limitBytes] = await Promise.all
        ([
            StorageQuotaEnforcer.getUsedBytes(userId),
            StorageQuotaEnforcer.getLimitBytes(userId)
        ]);
        return StorageQuotaEnforcer.fitsWithinLimit(usedBytes, additionalBytes, limitBytes);
    }

    /**
     * Drops the cached footprint for a user (e.g. after a large deletion) so the
     * next check re-measures rather than trusting a stale over-cap reading.
     */
    static invalidate(userId)
    {
        StorageQuotaEnforcer.#footprintCache.delete(userId);
    }

    // Measures both storage categories concurrently and returns the split plus
    // the combined total.
    static async #computeBreakdown(userId)
    {
        const [decksBytes, uploadsBytes] = await Promise.all
        ([
            StorageQuotaEnforcer.#computeDecksBytes(userId),
            StorageQuotaEnforcer.#computeUploadsBytes(userId)
        ]);
        return { decksBytes: decksBytes, uploadsBytes: uploadsBytes, totalBytes: decksBytes + uploadsBytes };
    }

    // The DECKS category: the BSON document footprint across the synced content
    // collections. Collapsed into a single $unionWith pipeline (one round trip,
    // one pool checkout) instead of one aggregate() call per collection — under
    // many concurrent users a per-collection loop was multiplying connection-pool
    // pressure 5x for no benefit, since every collection is already indexed on
    // userId.
    static async #computeDecksBytes(userId)
    {
        const database = await DatabaseConnector.getDatabase();
        const [firstCollectionName, ...remainingCollectionNames] = StorageQuotaEnforcer.#COUNTED_COLLECTIONS;

        // A user's content lives under several owner keys once they belong to
        // an organization: their personal one, plus one per organization view.
        // The cap is the USER's, so the measurement has to cover everything they
        // hold — measuring the personal scope alone would let an organization
        // view grow without limit.
        const scopeKeys = await StorageQuotaEnforcer.#listScopeKeys(userId);
        const ownerMatch = { userId: { $in: scopeKeys } };

        const unionStages = remainingCollectionNames.map(collectionName => (
        {
            $unionWith: { coll: collectionName, pipeline: [ { $match: ownerMatch } ] }
        }));

        const aggregationResult = await database.collection(firstCollectionName).aggregate
        ([
            { $match: ownerMatch },
            ...unionStages,
            { $group: { _id: null, totalSize: { $sum: { $bsonSize: "$$ROOT" } } } }
        ]).toArray();

        return aggregationResult[0]?.totalSize || 0;
    }

    /**
     * Every owner key this account's content can be stored under. Uploads are
     * NOT scoped this way — an information source belongs to the person who
     * uploaded it regardless of which view they were in — so only the deck
     * measurement uses this.
     *
     * Falls back to the personal key alone if the lookup fails, so a transient
     * database problem under-reports rather than blocking a legitimate sync.
     */
    static async #listScopeKeys(userId)
    {
        try
        {
            const AuthenticationQueryEngine = require("../Database/AuthenticationQueryEngine");
            const OrganizationScopeResolver = require("../Organization/OrganizationScopeResolver");

            const user = await AuthenticationQueryEngine.getUserById(userId);
            if (!user)
            {
                return [userId];
            }

            const scope = await OrganizationScopeResolver.listAllScopeKeysForUser(user);
            return scope.scopeKeys;
        }
        catch (scopeError)
        {
            console.warn(`[StorageQuotaEnforcer] Scope lookup failed for ${userId}: ${scopeError?.message || scopeError}`);
            return [userId];
        }
    }

    // The UPLOADS category: the stored file size of the user's PERMANENT
    // information-source blobs. Documents predating the retentionMode field are
    // treated as permanent (the prior default was to keep everything) — the same
    // rule StorageCreditAssessor bills the bucket footprint by, so the meter and
    // the billing agree.
    static async #computeUploadsBytes(userId)
    {
        const database = await DatabaseConnector.getDatabase();
        const aggregationResult = await database.collection(DatabaseConstants.INFORMATION_SOURCES_COLLECTION).aggregate
        ([
            {
                $match:
                {
                    userId: userId,
                    $or:
                    [
                        { retentionMode: contentRetentionModes.PERMANENT },
                        { retentionMode: { $exists: false } }
                    ]
                }
            },
            { $group: { _id: null, totalBytes: { $sum: "$fileSizeBytes" } } }
        ]).toArray();

        return aggregationResult[0]?.totalBytes || 0;
    }
}

module.exports = StorageQuotaEnforcer;
