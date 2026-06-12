const DatabaseConstants = require('../../Constants/DatabaseConstants');
const DatabaseConnector = require('../Database/DatabaseConnector');
const AuthenticationQueryEngine = require('../Database/AuthenticationQueryEngine');
const { creditChargeCategories } = require('../../Enumerations/CreditChargeCategories');
const { creditTransactionTypes } = require('../../Enumerations/CreditTransactionTypes');
const { contentRetentionModes } = require('../../Enumerations/ContentRetentionModes');
const CreditConfigurationStore = require('./CreditConfigurationStore');
const CreditLedger = require('./CreditLedger');

// Lazily charges the recurring storage categories (MongoDB documents + GCS
// bucket) on a natural per-user hook (sync). There is no scheduler in the
// stack, so instead of a cron sweep we assess at most once per 24h per user
// and bill for the elapsed time since the last assessment — the rule's
// DURATION_SECONDS divisor turns "X credits per MB" into a recurring rate.
//
// Only content the user chose to keep PERMANENT counts toward the bucket
// footprint; TEMPORARY uploads are exempt by design.

class StorageCreditAssessor
{
    static #ASSESSMENT_INTERVAL_MILLISECONDS = 24 * 60 * 60 * 1000;
    static #BYTES_PER_MEGABYTE = 1024 * 1024;

    // Users with an assessment currently running. A single sync session fires
    // many /Sync calls (chunked pull + multiple devices); without this guard
    // they would all clear the 24h debounce at once and run the footprint
    // aggregation redundantly. The per-day idempotency key already prevents a
    // double-charge — this just avoids the wasted concurrent work.
    static #inFlightUserIds = new Set();

    /**
     * Assesses and charges a user's storage footprint if their debounce
     * window has elapsed. Never throws — storage accounting must not be able
     * to break a sync.
     * @param {object} user — a User model instance
     */
    static async assess(user)
    {
        let trackedUserId = null;
        try
        {
            if (!user)
            {
                return;
            }

            const userId = user.getId();

            if (StorageCreditAssessor.#inFlightUserIds.has(userId))
            {
                return;
            }
            StorageCreditAssessor.#inFlightUserIds.add(userId);
            trackedUserId = userId;
            const additionalData = user.getAdditionalData() || {};
            const now = new Date();

            const lastAssessedRaw = additionalData.lastStorageAssessedAt;
            const lastAssessedAt = lastAssessedRaw ? new Date(lastAssessedRaw) : null;

            if (lastAssessedAt !== null && !isNaN(lastAssessedAt.getTime()) && (now.getTime() - lastAssessedAt.getTime()) < StorageCreditAssessor.#ASSESSMENT_INTERVAL_MILLISECONDS)
            {
                return;
            }

            // First-ever assessment: establish the baseline without
            // back-billing a footprint that accumulated before billing began.
            if (lastAssessedAt === null || isNaN(lastAssessedAt.getTime()))
            {
                await AuthenticationQueryEngine.updateUserAdditionalData(userId, { lastStorageAssessedAt: now.toISOString() });
                return;
            }

            const configuration = await CreditConfigurationStore.load();
            // Storage has no "deny" concept — a disabled (or absent) category
            // simply isn't billed. Only charge when an enabled rule exists.
            const mongoRuleCandidate = configuration.getStorageRule(creditChargeCategories.MONGODB_STORAGE);
            const bucketRuleCandidate = configuration.getStorageRule(creditChargeCategories.STORAGE_BUCKET);
            const mongoStorageRule = (mongoRuleCandidate !== null && mongoRuleCandidate.getEnabled()) ? mongoRuleCandidate : null;
            const bucketStorageRule = (bucketRuleCandidate !== null && bucketRuleCandidate.getEnabled()) ? bucketRuleCandidate : null;

            const elapsedSeconds = Math.max(0, (now.getTime() - lastAssessedAt.getTime()) / 1000);
            // One charge per UTC day per category — the debounce keeps
            // assessments ≥24h apart, so the day index is a stable idempotency
            // stamp that lets the next window charge again.
            const periodStamp = Math.floor(now.getTime() / StorageCreditAssessor.#ASSESSMENT_INTERVAL_MILLISECONDS);

            if (mongoStorageRule !== null)
            {
                const megabytes = await StorageCreditAssessor.#computeMongoDocumentMegabytes(userId);
                const cost = mongoStorageRule.evaluate({ STORAGE_MEGABYTES: megabytes, DURATION_SECONDS: elapsedSeconds });
                await CreditLedger.charge
                (
                    userId,
                    cost,
                    creditTransactionTypes.STORAGE_CHARGE,
                    `storage:${userId}:MONGODB_STORAGE:${periodStamp}`,
                    { category: "MONGODB_STORAGE", megabytes: megabytes, elapsedSeconds: elapsedSeconds },
                    mongoStorageRule.getMinimumBalanceFloor()
                );
            }

            if (bucketStorageRule !== null)
            {
                const megabytes = await StorageCreditAssessor.#computeBucketMegabytes(userId);
                const cost = bucketStorageRule.evaluate({ STORAGE_MEGABYTES: megabytes, DURATION_SECONDS: elapsedSeconds });
                await CreditLedger.charge
                (
                    userId,
                    cost,
                    creditTransactionTypes.STORAGE_CHARGE,
                    `storage:${userId}:STORAGE_BUCKET:${periodStamp}`,
                    { category: "STORAGE_BUCKET", megabytes: megabytes, elapsedSeconds: elapsedSeconds },
                    bucketStorageRule.getMinimumBalanceFloor()
                );
            }

            await AuthenticationQueryEngine.updateUserAdditionalData(userId, { lastStorageAssessedAt: now.toISOString() });
        }
        catch (assessError)
        {
            console.warn(`[StorageCreditAssessor] assessment failed: ${assessError?.message || assessError}`);
        }
        finally
        {
            if (trackedUserId !== null)
            {
                StorageCreditAssessor.#inFlightUserIds.delete(trackedUserId);
            }
        }
    }

    /**
     * Sums the BSON size of every document the user owns across the synced
     * content collections, in megabytes.
     */
    static async #computeMongoDocumentMegabytes(userId)
    {
        const database = await DatabaseConnector.getDatabase();
        const collectionNames =
        [
            DatabaseConstants.DECKS_COLLECTION,
            DatabaseConstants.CARDS_COLLECTION,
            DatabaseConstants.STUDY_MATERIALS_COLLECTION,
            DatabaseConstants.MOCK_TESTS_COLLECTION,
            DatabaseConstants.INFORMATION_SOURCES_COLLECTION,
        ];

        let totalBytes = 0;
        for (const collectionName of collectionNames)
        {
            const aggregationResult = await database.collection(collectionName).aggregate
            ([
                { $match: { userId: userId } },
                { $group: { _id: null, totalSize: { $sum: { $bsonSize: "$$ROOT" } } } },
            ]).toArray();
            totalBytes += aggregationResult[0]?.totalSize || 0;
        }

        return totalBytes / StorageCreditAssessor.#BYTES_PER_MEGABYTE;
    }

    /**
     * Sums the stored file size of the user's PERMANENT information sources,
     * in megabytes. Documents predating the retentionMode field are treated
     * as permanent (the prior default behaviour was to keep everything).
     */
    static async #computeBucketMegabytes(userId)
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
                        { retentionMode: { $exists: false } },
                    ],
                },
            },
            { $group: { _id: null, totalBytes: { $sum: "$fileSizeBytes" } } },
        ]).toArray();

        const totalBytes = aggregationResult[0]?.totalBytes || 0;
        return totalBytes / StorageCreditAssessor.#BYTES_PER_MEGABYTE;
    }
}

module.exports = StorageCreditAssessor;
