const UserSubscriptionQueryEngine = require("../Database/UserSubscriptionQueryEngine");
const DatabaseConstants = require("../../Constants/DatabaseConstants");

/**
 * SourceRetentionPolicy — decides when a user's uploaded documents become
 * eligible for deletion.
 *
 * The rule, uniform at SOURCE_RETENTION_GRACE_DAYS across every case:
 *
 *   - Subscribed        -> retained. The relationship is live, so the copy is
 *                          held to provide the service the user is paying for.
 *   - Subscription ended-> every source deleted that many days after the
 *                          period end, regardless of when it was uploaded.
 *   - Never subscribed  -> each source deleted that many days after ITS OWN
 *                          upload, since there is no relationship end to key on.
 *
 * Why this shape matters legally. Holding a user's own document for as long as
 * they are a paying customer, then deleting it after a defined grace period, is
 * how ordinary storage services behave and is a defensible private-copy posture.
 * What is NOT defensible is unbounded accumulation — which is exactly what an
 * un-triggered free tier would reintroduce, so the never-subscribed branch is
 * load-bearing, not an afterthought.
 *
 * The cutoff is DERIVED on each sweep rather than stamped onto the row at upload
 * time. That is deliberate: a stamped date goes stale the moment a user
 * subscribes, lapses or resubscribes, and keeping it correct would mean hooking
 * every subscription lifecycle event and never missing one. Deriving it means
 * there is no event to miss and no state to repair.
 */
class SourceRetentionPolicy
{
    static #GRACE_MILLISECONDS = DatabaseConstants.SOURCE_RETENTION_GRACE_DAYS * 24 * 60 * 60 * 1000;

    /**
     * Resolves how long a given user's sources may be kept.
     *
     * @param {string} userId
     * @param {number} nowMilliseconds
     * @return {Promise<{bRetained: boolean, deleteBeforeMilliseconds: number|null, reason: string}>}
     *   bRetained                -> true when nothing of this user's may be deleted yet.
     *   deleteBeforeMilliseconds -> when set, delete sources whose uploadedAt is
     *                               older than this value (the never-subscribed
     *                               case). When null and bRetained is false, ALL
     *                               of the user's sources are due (the lapsed case).
     */
    static async resolveForUser(userId, nowMilliseconds)
    {
        const activeSubscription = await UserSubscriptionQueryEngine.getActiveByUserId(userId);
        if (activeSubscription !== null)
        {
            return { bRetained: true, deleteBeforeMilliseconds: null, reason: "subscription active" };
        }

        const latestSubscription = await UserSubscriptionQueryEngine.getLatestByUserId(userId);
        const periodEndMilliseconds = latestSubscription !== null ? latestSubscription.getCurrentPeriodEndAt() : null;

        if (typeof periodEndMilliseconds === "number" && periodEndMilliseconds > 0)
        {
            const graceExpiresAt = periodEndMilliseconds + SourceRetentionPolicy.#GRACE_MILLISECONDS;
            if (nowMilliseconds < graceExpiresAt)
            {
                return { bRetained: true, deleteBeforeMilliseconds: null, reason: "within post-subscription grace" };
            }

            // Grace elapsed — every source this user owns is due, whenever it
            // was uploaded.
            return { bRetained: false, deleteBeforeMilliseconds: null, reason: "post-subscription grace elapsed" };
        }

        // Never subscribed. Each source ages out on its own upload date, so the
        // caller filters by uploadedAt rather than deleting the whole set.
        return {
            bRetained: false,
            deleteBeforeMilliseconds: nowMilliseconds - SourceRetentionPolicy.#GRACE_MILLISECONDS,
            reason: "free tier"
        };
    }

    /**
     * Applies a resolved policy to one source.
     *
     * A source with an explicit expiry stamp (the TEMPORARY retention mode) is
     * due once that stamp passes, independently of the subscription rule — an
     * explicit shorter promise to the user must not be overridden by a longer
     * default.
     *
     * @param {InformationSource} informationSource
     * @param {{bRetained: boolean, deleteBeforeMilliseconds: number|null}} policy
     * @param {number} nowMilliseconds
     * @return {boolean} True when the source may be deleted now.
     */
    static isSourceDue(informationSource, policy, nowMilliseconds)
    {
        const explicitExpiry = informationSource.getExpiresAt();
        if (typeof explicitExpiry === "number" && explicitExpiry > 0 && explicitExpiry <= nowMilliseconds)
        {
            return true;
        }

        if (policy.bRetained)
        {
            return false;
        }

        if (policy.deleteBeforeMilliseconds === null)
        {
            return true;
        }

        // Free tier: age out on the source's own upload date. A row written
        // before uploadedAt existed reports 0, which is older than any cutoff
        // and is therefore due — correct, since such a row predates this policy
        // and has by definition been held longer than the grace period.
        const uploadedAt = informationSource.getUploadedAt();
        const effectiveUploadedAt = (typeof uploadedAt === "number" && uploadedAt > 0) ? uploadedAt : 0;
        return effectiveUploadedAt <= policy.deleteBeforeMilliseconds;
    }
}

module.exports = SourceRetentionPolicy;
