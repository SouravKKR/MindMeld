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
    static isSourceDue(informationSource, policy, nowMilliseconds, referencedProofHashes = null)
    {
        // Legal hold outranks every other rule, including the explicit TEMPORARY
        // expiry below it. See isSourceUnderLegalHold for why.
        if (SourceRetentionPolicy.isSourceUnderLegalHold(informationSource, referencedProofHashes))
        {
            return false;
        }

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

    /**
     * True when this source is cited as a licensing basis and must therefore
     * outlive the ordinary retention rules.
     *
     * There are two ways a source becomes cited — as the reference a content
     * refinement was made from, and as a declared verification source for a paid
     * deck. This method does not distinguish them and does not need to: it is
     * given a set of held hashes, and ReferencedProofSourceHashes is the one
     * place that knows how to build that set from both.
     *
     * Why a hold exists at all. When a reviewer corrects or checks sellable
     * content against a reference document, the claim being made is "we were
     * entitled to use this" — and the declaration is only worth something while
     * the document it describes can still be produced. Every rule above this one
     * would eventually delete it: a lapsed subscription deletes the whole set
     * sixty days later, and a free-tier account ages each file out on its own
     * upload date. Both would land precisely when the proof is most likely to
     * be asked for.
     *
     * Why it keys on the CONTENT HASH rather than a flag on the row. Objects
     * are content-addressed, so the hash names the bytes rather than the
     * record, and a hold cannot be lost by the row being rewritten. It also
     * avoids retroactively editing the retention promise the user was shown
     * when they uploaded a file for some other purpose: their row keeps saying
     * what it said, and the hold lives with the record that depends on it.
     *
     * A null referencedProofHashes means the caller did not look them up, which
     * is treated as "no hold" — every caller that can delete is responsible for
     * loading the set. That is a deliberate default: the alternative, holding
     * everything when the lookup was skipped, would silently disable the reaper
     * on the first caller that forgot.
     *
     * @param {InformationSource} informationSource
     * @param {Set<string>|null} referencedProofHashes
     * @return {boolean}
     */
    static isSourceUnderLegalHold(informationSource, referencedProofHashes)
    {
        if (!referencedProofHashes || typeof referencedProofHashes.has !== "function")
        {
            return false;
        }

        const contentHash = informationSource.getHash();

        if (typeof contentHash !== "string" || contentHash.length === 0)
        {
            return false;
        }

        return referencedProofHashes.has(contentHash);
    }
}

module.exports = SourceRetentionPolicy;
