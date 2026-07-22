const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const CreditLedger = require("../Credits/CreditLedger");
const PlanMetadata = require("../Plans/PlanMetadata");
const PlanTierResolver = require("../Plans/PlanTierResolver");
const DeckLicense = require("../../Model/DeckLicense");
const GrantSources = require("../../Constants/GrantSources");
const { creditTransactionTypes } = require("../../Enumerations/CreditTransactionTypes");
const { couponBenefitTargets } = require("../../Enumerations/CouponBenefitTargets");
const { subscriptionStatuses } = require("../../Enumerations/SubscriptionStatuses");
const ErrorCodes = require("../../Constants/ErrorCodes");

// Applies a STANDALONE coupon benefit (a grant) AFTER the redemption row has
// been inserted as the unique guard. Each grant is idempotent or guarded so a
// replay is safe: credits via the ledger referenceKey, plan/deck via the
// unique redemption row that gates a second call. Discount benefits are NOT
// handled here — they are applied at checkout by CouponResolver.

class CouponGrantService
{
    /**
     * @param {User} user
     * @param {Coupon} coupon
     * @param {number} nowMilliseconds
     * @returns {Promise<{applied: boolean, reason?: string, grantedCredits?: number, grantedPlanTier?: number, grantedDeckLicenseId?: string|null, benefitExpiresAt?: number|null, grantedSummary?: string}>}
     */
    static async applyStandaloneBenefit(user, coupon, nowMilliseconds = Date.now())
    {
        switch (Number(coupon.getBenefitTarget()))
        {
            case couponBenefitTargets.GRANT_CREDITS:
                return await CouponGrantService.#grantCredits(user, coupon);
            case couponBenefitTargets.GRANT_FREE_PLAN:
                return await CouponGrantService.#grantFreePlan(user, coupon, nowMilliseconds);
            case couponBenefitTargets.GRANT_FREE_DECK:
                return await CouponGrantService.#grantFreeDeck(user, coupon, nowMilliseconds);
            default:
                // A discount coupon reached the standalone path — the client
                // should apply it at checkout instead.
                return { applied: false, reason: ErrorCodes.COUPON_NOT_APPLICABLE };
        }
    }

    static async #grantCredits(user, coupon)
    {
        const amount = coupon.getBenefitValue();
        if (amount <= 0)
        {
            return { applied: false, reason: ErrorCodes.INVALID_BENEFIT_VALUE };
        }

        const grantResult = await CreditLedger.grant
        (
            user.getId(),
            amount,
            creditTransactionTypes.COUPON_GRANT,
            `couponRedeem:${coupon.getId()}:${user.getId()}`,
            { codeString: coupon.getCodeString(), couponId: coupon.getId(), email: user.getAdditionalData()?.email || "" }
        );

        // `applied` is true for both a first grant and an idempotent replay of a
        // succeeded grant. It is false when the grant was rejected (e.g. the user
        // row was missing) — including a replay of a rejected transaction — so
        // gate on `applied` alone rather than `applied || alreadyApplied`, which
        // would falsely report success for a rejected replay.
        if (!grantResult.applied)
        {
            return { applied: false, reason: ErrorCodes.PERSIST_FAILED };
        }

        return { applied: true, grantedCredits: grantResult.amount, grantedSummary: `${amount} credits` };
    }

    static async #grantFreePlan(user, coupon, nowMilliseconds)
    {
        const targetTier = coupon.getTargetPlanTier();
        if (targetTier === null)
        {
            return { applied: false, reason: ErrorCodes.INVALID_PLAN_TIER };
        }
        const benefitExpiresAt = coupon.computeBenefitExpiresAt(nowMilliseconds);
        if (benefitExpiresAt === null)
        {
            return { applied: false, reason: ErrorCodes.INVALID_DURATION_VALUE };
        }

        // Never make the user worse off: take the better tier and the further-out
        // expiry, and preserve an existing auto-renew subscription id.
        const currentTier = PlanTierResolver.getStoredTier(user);
        const currentExpiry = PlanTierResolver.getExpiresAt(user);
        const currentSubscriptionId = PlanTierResolver.getSubscriptionId(user);

        const resultTier = Math.max(Number(targetTier), Number(currentTier));
        const resultExpiry = (currentExpiry !== null) ? Math.max(currentExpiry, benefitExpiresAt) : benefitExpiresAt;

        const setFields =
        {
            "additionalData.plan": resultTier,
            "additionalData.planExpiresAt": resultExpiry,
            "additionalData.planStatus": subscriptionStatuses.ACTIVE
        };
        if (!currentSubscriptionId)
        {
            setFields["additionalData.planSubscriptionId"] = null;
        }

        const usersCollection = (await DatabaseConnector.getDatabase())
            .collection(DatabaseConstants.USERS_COLLECTION);
        await usersCollection.updateOne({ id: user.getId() }, { $set: setFields });

        return {
            applied: true,
            grantedPlanTier: Number(targetTier),
            benefitExpiresAt: resultExpiry,
            grantedSummary: `Free ${PlanMetadata.getLabel(targetTier)} plan until ${new Date(resultExpiry).toISOString()}`
        };
    }

    static async #grantFreeDeck(user, coupon, nowMilliseconds)
    {
        const targetDeckId = coupon.getTargetDeckId();
        if (!targetDeckId)
        {
            return { applied: false, reason: ErrorCodes.MISSING_DECK_ID };
        }

        const benefitExpiresAtMs = coupon.computeBenefitExpiresAt(nowMilliseconds);
        const expiresAt = benefitExpiresAtMs !== null ? new Date(benefitExpiresAtMs) : DeckLicense.FOREVER;

        // Lazy-require to avoid a Globals→Endpoints load-order dependency.
        const { grantAndSeedDeck } = require("../../../Endpoints/PaidDeck/PaidDeckGrantHelpers");
        const database = await DatabaseConnector.getDatabase();
        const licenseJson = await grantAndSeedDeck(database, user.getId(), targetDeckId, { expiresAt: expiresAt, grantSource: GrantSources.COUPON });

        if (!licenseJson)
        {
            return { applied: false, reason: ErrorCodes.LICENSE_PERSIST_FAILED };
        }

        return {
            applied: true,
            grantedDeckLicenseId: licenseJson.id ?? null,
            benefitExpiresAt: benefitExpiresAtMs,
            grantedSummary: `Free deck ${targetDeckId}`
        };
    }
}

module.exports = CouponGrantService;
