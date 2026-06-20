const MetricBadges = require("../../Constants/MetricBadges");
const AuthenticationQueryEngine = require("../Database/AuthenticationQueryEngine");
const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const { mockTestEvaluationStatuses } = require("../../Enumerations/MockTestEvaluationStatuses");

// Owns the cumulative achievement metrics + milestone badges in
// users.additionalData.metrics (mutated ONLY here; the generic
// /UpdateUserAdditionalData merge refuses the `metrics` key).
//
// Cards and mock tests are RECOMPUTED authoritatively from the user's MongoDB
// entities (progress + attempt history are plaintext, including paid decks), so
// they cannot be inflated by a client. Hours (minutesStudied) and doubts are not
// derivable from stored entities, so they stay client-reported with a per-metric
// elapsed-time clamp.

class MetricBadgeManager
{
    static METRIC_OWNED_ADDITIONAL_DATA_KEYS = ["metrics"];

    // Counters reported by the client. Only study time remains here — it can't be
    // reconstructed from stored entities. Doubts are now counted authoritatively
    // server-side at the AskAi endpoint (recordDoubtAsked), and cards / mock tests
    // are recomputed from Mongo, so none of those can be inflated by a client.
    static REPORTED_METRIC_KEYS = ["minutesStudied"];

    // Counters recomputed server-side from the user's Mongo entities. These are
    // lifetime-achievement counters, so they must never decrease when entities
    // are deleted (see #applyDeletionCreditedCount).
    static DERIVED_METRIC_KEYS = ["cardsStudied", "mockTestsTaken"];

    // Largest elapsed window credited between two real credits of the same
    // reported metric (so a genuine long session still credits fully).
    static MAXIMUM_CREDITED_ELAPSED_SECONDS = 6 * 60 * 60;

    // Window used for a reported metric's FIRST-ever credit (no prior timestamp).
    static FIRST_CREDIT_WINDOW_SECONDS = 5 * 60;

    // Minimum real seconds each unit of a reported metric must take.
    static SECONDS_PER_UNIT =
    {
        minutesStudied: 60,
    };

    // Only one mock test per this many minutes counts toward the badge.
    static MOCK_TEST_MINIMUM_SPACING_MINUTES = 15;

    // The card/mock recompute reads Mongo; skip it when run again within this
    // window so frequent triggers don't repeatedly aggregate.
    static RECOMPUTE_THROTTLE_SECONDS = 30;

    static isMetricOwnedAdditionalDataKey(fieldKey)
    {
        return MetricBadgeManager.METRIC_OWNED_ADDITIONAL_DATA_KEYS.includes(fieldKey);
    }

    static #categories()
    {
        return Object.keys(MetricBadges);
    }

    static #categoryForMetricKey(metricKey)
    {
        return MetricBadgeManager.#categories().find((category) => MetricBadges[category].metricKey === metricKey) || null;
    }

    static #emptyLastCreditAt()
    {
        const lastCreditAt = {};
        for (const key of MetricBadgeManager.REPORTED_METRIC_KEYS)
        {
            lastCreditAt[key] = 0;
        }
        return lastCreditAt;
    }

    // Per-derived-metric { lastRaw, deletionCredit } used to keep the lifetime
    // counter monotonic across entity deletions (see #applyDeletionCreditedCount).
    static #emptyRecomputeBaselines()
    {
        const baselines = {};
        for (const key of MetricBadgeManager.DERIVED_METRIC_KEYS)
        {
            baselines[key] = { lastRaw: 0, deletionCredit: 0 };
        }
        return baselines;
    }

    static #defaultMetrics()
    {
        const badges = {};
        for (const category of MetricBadgeManager.#categories())
        {
            badges[category] = [];
        }
        return { cardsStudied: 0, mockTestsTaken: 0, minutesStudied: 0, doubtsAsked: 0, leaderboardScore: 0, lastRecomputeAt: 0, lastCreditAt: MetricBadgeManager.#emptyLastCreditAt(), recomputeBaselines: MetricBadgeManager.#emptyRecomputeBaselines(), badges };
    }

    static #normalise(rawMetrics)
    {
        if (!rawMetrics || typeof rawMetrics !== "object")
        {
            return MetricBadgeManager.#defaultMetrics();
        }

        const safeCount = (value) => (Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0);

        const metrics =
        {
            cardsStudied: safeCount(rawMetrics.cardsStudied),
            mockTestsTaken: safeCount(rawMetrics.mockTestsTaken),
            minutesStudied: safeCount(rawMetrics.minutesStudied),
            doubtsAsked: safeCount(rawMetrics.doubtsAsked),
            leaderboardScore: safeCount(rawMetrics.leaderboardScore),
            lastRecomputeAt: Number.isFinite(rawMetrics.lastRecomputeAt) ? Math.max(0, Math.floor(rawMetrics.lastRecomputeAt)) : 0,
            lastCreditAt: MetricBadgeManager.#emptyLastCreditAt(),
            badges: {},
        };

        const rawLastCreditAt = rawMetrics.lastCreditAt && typeof rawMetrics.lastCreditAt === "object" ? rawMetrics.lastCreditAt : {};
        for (const key of MetricBadgeManager.REPORTED_METRIC_KEYS)
        {
            metrics.lastCreditAt[key] = Number.isFinite(rawLastCreditAt[key]) ? Math.max(0, Math.floor(rawLastCreditAt[key])) : 0;
        }

        for (const category of MetricBadgeManager.#categories())
        {
            metrics.badges[category] = rawMetrics.badges && Array.isArray(rawMetrics.badges[category]) ? rawMetrics.badges[category] : [];
        }

        const rawBaselines = rawMetrics.recomputeBaselines && typeof rawMetrics.recomputeBaselines === "object" ? rawMetrics.recomputeBaselines : {};
        metrics.recomputeBaselines = {};
        for (const key of MetricBadgeManager.DERIVED_METRIC_KEYS)
        {
            const stored = rawBaselines[key];
            if (stored && Number.isFinite(stored.lastRaw) && Number.isFinite(stored.deletionCredit))
            {
                metrics.recomputeBaselines[key] = { lastRaw: Math.max(0, Math.floor(stored.lastRaw)), deletionCredit: Math.max(0, Math.floor(stored.deletionCredit)) };
            }
            else
            {
                // Migration / first run: treat the already-displayed counter as the
                // last observed raw so the first recompute can neither rewind nor
                // double-count it.
                metrics.recomputeBaselines[key] = { lastRaw: metrics[key] || 0, deletionCredit: 0 };
            }
        }

        return metrics;
    }

    static #computeLeaderboardScore(metrics)
    {
        let score = 0;
        for (const category of MetricBadgeManager.#categories())
        {
            const definition = MetricBadges[category];
            score += (metrics[definition.metricKey] || 0) * (definition.xpPerUnit || 0);
        }
        return Math.floor(score);
    }

    // Awards every badge in a category whose threshold the counter has reached
    // and that is not already earned. Mutates the earned array; returns awards.
    static #awardCategoryBadges(metrics, category, now)
    {
        const definition = MetricBadges[category];
        const counterValue = metrics[definition.metricKey] || 0;
        const earnedList = metrics.badges[category];
        const alreadyEarnedThresholds = new Set(earnedList.map((badge) => badge.threshold));

        const newlyAwarded = [];
        for (const badge of definition.badges)
        {
            if (badge.threshold <= counterValue && !alreadyEarnedThresholds.has(badge.threshold))
            {
                earnedList.push({ threshold: badge.threshold, awardedAt: now.toISOString(), acknowledged: false });
                newlyAwarded.push({ category: category, badge: badge });
            }
        }
        return newlyAwarded;
    }

    static #parseTimestampMilliseconds(value)
    {
        if (value instanceof Date)
        {
            return value.getTime();
        }
        if (typeof value === "number")
        {
            return value;
        }
        if (typeof value === "string")
        {
            return Date.parse(value);
        }
        return NaN;
    }

    // Applies the client-reported minutes/doubts increments, each clamped to what
    // is physically possible since that metric was last credited. Mutates metrics;
    // returns newly-awarded badges and whether anything changed.
    static #applyReportedIncrementsInPlace(metrics, increments, nowMilliseconds, now)
    {
        const newlyAwarded = [];
        let changed = false;

        for (const metricKey of MetricBadgeManager.REPORTED_METRIC_KEYS)
        {
            const requested = Number.isFinite(increments[metricKey]) ? Math.max(0, Math.floor(increments[metricKey])) : 0;
            if (requested === 0)
            {
                continue;
            }

            const lastCreditAt = metrics.lastCreditAt[metricKey] || 0;
            const elapsedSeconds = lastCreditAt > 0
                ? Math.min((nowMilliseconds - lastCreditAt) / 1000, MetricBadgeManager.MAXIMUM_CREDITED_ELAPSED_SECONDS)
                : MetricBadgeManager.FIRST_CREDIT_WINDOW_SECONDS;

            const secondsPerUnit = MetricBadgeManager.SECONDS_PER_UNIT[metricKey] || 1;
            const applied = Math.min(requested, Math.ceil(elapsedSeconds / secondsPerUnit));
            if (applied <= 0)
            {
                continue;
            }

            metrics[metricKey] = (metrics[metricKey] || 0) + applied;
            metrics.lastCreditAt[metricKey] = nowMilliseconds;
            const category = MetricBadgeManager.#categoryForMetricKey(metricKey);
            if (category)
            {
                newlyAwarded.push(...MetricBadgeManager.#awardCategoryBadges(metrics, category, now));
            }
            changed = true;
        }

        return { newlyAwarded, changed };
    }

    // Maps a freshly-recomputed RAW count (entities currently in Mongo) to the
    // displayed lifetime counter, which must never decrease. Any drop below the
    // last observed raw is attributed to deletions and banked as a permanent
    // credit; the displayed value is currentRaw + accumulatedDeletionCredit. So a
    // deletion never rewinds the counter, yet post-deletion study still raises it
    // immediately (unlike a plain high-water Math.max, which would freeze it).
    // Mutates the per-metric baseline and returns the displayed value.
    static #applyDeletionCreditedCount(metrics, derivedMetricKey, rawCount)
    {
        const baseline = metrics.recomputeBaselines[derivedMetricKey];
        if (rawCount < baseline.lastRaw)
        {
            baseline.deletionCredit += (baseline.lastRaw - rawCount);
        }
        baseline.lastRaw = rawCount;
        return rawCount + baseline.deletionCredit;
    }

    // Recomputes cards (Σ last-progress-point fsrs.repetitions) and mock tests
    // (COMPLETED attempts, ≥15 min apart) from the user's Mongo entities — paid
    // decks included (same collections, plaintext progress/history). Mutates
    // metrics; returns newly-awarded badges. Returns null when skipped/failed.
    static async #recomputeDerivedInPlace(metrics, userId, now)
    {
        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            return null;
        }

        // null = the aggregation failed; the counter is then left untouched (no
        // rewind, no spurious deletion credit).
        let rawCardsStudied = null;
        let rawMockTestsTaken = null;

        try
        {
            const cardsCollection = database.collection(DatabaseConstants.CARDS_COLLECTION);
            const cardAggregation = await cardsCollection.aggregate(
            [
                { $match: { userId: userId } },
                { $project: { reviews: { $ifNull: [ { $arrayElemAt: ["$data.progress.progressPoints.fsrs.repetitions", -1] }, 0 ] } } },
                { $group: { _id: null, total: { $sum: "$reviews" } } }
            ]).toArray();
            rawCardsStudied = cardAggregation.length > 0 ? Math.max(0, Math.floor(cardAggregation[0].total || 0)) : 0;
        }
        catch (cardError)
        {
            console.warn(`[MetricBadgeManager] Card recompute failed for ${userId}: ${cardError?.message || cardError}`);
        }

        try
        {
            const mockTestsCollection = database.collection(DatabaseConstants.MOCK_TESTS_COLLECTION);
            const mockDocuments = await mockTestsCollection
                .find({ userId: userId }, { projection: { "data.history.evaluationStatus": 1, "data.history.attemptDate": 1 } })
                .toArray();

            const completedTimestamps = [];
            for (const document of mockDocuments)
            {
                const history = document?.data?.history;
                if (!Array.isArray(history))
                {
                    continue;
                }
                for (const attempt of history)
                {
                    if (attempt && attempt.evaluationStatus === mockTestEvaluationStatuses.COMPLETED)
                    {
                        const timestamp = MetricBadgeManager.#parseTimestampMilliseconds(attempt.attemptDate);
                        if (Number.isFinite(timestamp))
                        {
                            completedTimestamps.push(timestamp);
                        }
                    }
                }
            }

            completedTimestamps.sort((first, second) => first - second);
            const spacingMilliseconds = MetricBadgeManager.MOCK_TEST_MINIMUM_SPACING_MINUTES * 60 * 1000;
            let counted = 0;
            let lastCountedTimestamp = -Infinity;
            for (const timestamp of completedTimestamps)
            {
                if (timestamp - lastCountedTimestamp >= spacingMilliseconds)
                {
                    counted++;
                    lastCountedTimestamp = timestamp;
                }
            }
            rawMockTestsTaken = counted;
        }
        catch (mockError)
        {
            console.warn(`[MetricBadgeManager] Mock-test recompute failed for ${userId}: ${mockError?.message || mockError}`);
        }

        // The recompute reflects only the entities CURRENTLY in Mongo. Deleting a
        // card, mock test, or whole deck hard-removes its document (Sync uses
        // deleteOne/deleteMany), so the raw recount can fall. These are lifetime
        // achievement counters: a deletion must not rewind them, but genuine new
        // study afterwards must still count. #applyDeletionCreditedCount banks any
        // drop as a permanent credit and reports currentRaw + creditedDeletions.
        if (rawCardsStudied !== null)
        {
            metrics.cardsStudied = MetricBadgeManager.#applyDeletionCreditedCount(metrics, "cardsStudied", rawCardsStudied);
        }
        if (rawMockTestsTaken !== null)
        {
            metrics.mockTestsTaken = MetricBadgeManager.#applyDeletionCreditedCount(metrics, "mockTestsTaken", rawMockTestsTaken);
        }

        const newlyAwarded = [];
        newlyAwarded.push(...MetricBadgeManager.#awardCategoryBadges(metrics, MetricBadgeManager.#categoryForMetricKey("cardsStudied"), now));
        newlyAwarded.push(...MetricBadgeManager.#awardCategoryBadges(metrics, MetricBadgeManager.#categoryForMetricKey("mockTestsTaken"), now));
        return newlyAwarded;
    }

    /**
     * Single low-frequency sync: applies reported minutes/doubts increments and
     * recomputes cards/mock tests from Mongo (throttled), awards crossed badges,
     * recomputes the leaderboard score, and persists.
     *
     * @param {string} userId
     * @param {{minutesStudied?:number, doubtsAsked?:number}} increments
     * @returns {Promise<{metrics: object, newlyAwarded: Array}>}
     */
    static async syncMetrics(userId, increments = {})
    {
        if (!userId)
        {
            return { metrics: MetricBadgeManager.#defaultMetrics(), newlyAwarded: [] };
        }

        const user = await AuthenticationQueryEngine.getUserById(userId);
        if (!user)
        {
            return { metrics: MetricBadgeManager.#defaultMetrics(), newlyAwarded: [] };
        }

        const metrics = MetricBadgeManager.#normalise(user.getAdditionalData()?.metrics);
        const nowMilliseconds = Date.now();
        const now = new Date(nowMilliseconds);

        const safeIncrements = increments && typeof increments === "object" ? increments : {};
        const reportedResult = MetricBadgeManager.#applyReportedIncrementsInPlace(metrics, safeIncrements, nowMilliseconds, now);
        const newlyAwarded = [...reportedResult.newlyAwarded];
        let changed = reportedResult.changed;

        // Throttle the (heavier) Mongo recompute of cards/mock tests.
        const recomputeDue = (nowMilliseconds - metrics.lastRecomputeAt) >= MetricBadgeManager.RECOMPUTE_THROTTLE_SECONDS * 1000;
        if (recomputeDue)
        {
            const recomputeAwards = await MetricBadgeManager.#recomputeDerivedInPlace(metrics, userId, now);
            if (recomputeAwards !== null)
            {
                newlyAwarded.push(...recomputeAwards);
                metrics.lastRecomputeAt = nowMilliseconds;
                changed = true;
            }
        }

        if (!changed)
        {
            return { metrics, newlyAwarded };
        }

        metrics.leaderboardScore = MetricBadgeManager.#computeLeaderboardScore(metrics);
        await AuthenticationQueryEngine.updateUserAdditionalData(userId, { metrics });
        return { metrics, newlyAwarded };
    }

    /**
     * Counts a single doubt asked — called server-side when an AskAi stream
     * completes successfully, so it can't be inflated by a client (each doubt is
     * a real, credit-metered AI call). Awards any newly-crossed doubt badge,
     * recomputes the leaderboard score, and persists.
     *
     * @param {string} userId
     * @returns {Promise<{metrics: object, newlyAwarded: Array}>}
     */
    static async recordDoubtAsked(userId)
    {
        if (!userId)
        {
            return { metrics: MetricBadgeManager.#defaultMetrics(), newlyAwarded: [] };
        }

        const user = await AuthenticationQueryEngine.getUserById(userId);
        if (!user)
        {
            return { metrics: MetricBadgeManager.#defaultMetrics(), newlyAwarded: [] };
        }

        const metrics = MetricBadgeManager.#normalise(user.getAdditionalData()?.metrics);
        const now = new Date();

        metrics.doubtsAsked = (metrics.doubtsAsked || 0) + 1;

        const category = MetricBadgeManager.#categoryForMetricKey("doubtsAsked");
        const newlyAwarded = category ? MetricBadgeManager.#awardCategoryBadges(metrics, category, now) : [];

        metrics.leaderboardScore = MetricBadgeManager.#computeLeaderboardScore(metrics);
        await AuthenticationQueryEngine.updateUserAdditionalData(userId, { metrics });
        return { metrics, newlyAwarded };
    }

    /**
     * Marks milestone badges in a category as acknowledged so each celebration
     * is shown exactly once (consistent across the user's devices).
     *
     * @param {string} userId
     * @param {string} category — a MetricBadges category key
     * @param {number[]} thresholds
     * @returns {Promise<object|null>} the updated metrics, or null
     */
    static async acknowledgeBadges(userId, category, thresholds)
    {
        if (!userId || !MetricBadges[category] || !Array.isArray(thresholds) || thresholds.length === 0)
        {
            return null;
        }

        const user = await AuthenticationQueryEngine.getUserById(userId);
        if (!user)
        {
            return null;
        }

        const metrics = MetricBadgeManager.#normalise(user.getAdditionalData()?.metrics);
        const toAcknowledge = new Set(thresholds.map((value) => Math.floor(value)));

        let changed = false;
        for (const badge of metrics.badges[category])
        {
            if (toAcknowledge.has(badge.threshold) && badge.acknowledged !== true)
            {
                badge.acknowledged = true;
                changed = true;
            }
        }

        if (!changed)
        {
            return metrics;
        }

        await AuthenticationQueryEngine.updateUserAdditionalData(userId, { metrics });
        return metrics;
    }
}

module.exports = MetricBadgeManager;
