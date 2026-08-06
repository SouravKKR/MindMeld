const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const CreditLedger = require("../Credits/CreditLedger");
const PlanMetadata = require("./PlanMetadata");
const PlanTierResolver = require("./PlanTierResolver");
const UserSubscriptionQueryEngine = require("../Database/UserSubscriptionQueryEngine");
const { creditTransactionTypes } = require("../../Enumerations/CreditTransactionTypes");
const { subscriptionStatuses } = require("../../Enumerations/SubscriptionStatuses");

// Shared activation logic for a Razorpay subscription, used by BOTH the browser
// verify leg and the subscription webhook. Everything is idempotent on a
// deterministic referenceKey so the two paths (whichever lands first) converge:
// the second call is a no-op. Entitlement expiry is only ever EXTENDED, never
// shortened, so a grace state or a late webhook cannot cut a user's access.

class PlanSubscriptionService
{
    // Writes the fast-read plan mirror onto the user document. The four plan
    // keys are ledger-owned, so this server-side write is the only way they move.
    static async #applyEntitlement(userId, fields)
    {
        const setFields = {};
        if (fields.planTier !== undefined) { setFields["additionalData.plan"] = Number(fields.planTier); }
        if (fields.planExpiresAt !== undefined) { setFields["additionalData.planExpiresAt"] = fields.planExpiresAt === null ? null : Number(fields.planExpiresAt); }
        if (fields.planStatus !== undefined) { setFields["additionalData.planStatus"] = Number(fields.planStatus); }
        if (fields.planSubscriptionId !== undefined) { setFields["additionalData.planSubscriptionId"] = fields.planSubscriptionId; }

        if (Object.keys(setFields).length === 0)
        {
            return;
        }

        const usersCollection = (await DatabaseConnector.getDatabase())
            .collection(DatabaseConstants.USERS_COLLECTION);
        await usersCollection.updateOne({ id: userId }, { $set: setFields });
    }

    /**
     * Activates the plan WITHOUT granting credits: sets the user's entitlement
     * to ACTIVE at the subscription's tier, extends planExpiresAt to current_end
     * (never shortening), and marks the row ACTIVE. Used by the browser verify
     * leg and by subscription.activated — the authorization payment and the
     * first charge carry different Razorpay payment ids, so crediting lives
     * solely in applyChargedCycle to avoid a double grant.
     *
     * @param {UserSubscription} subscription
     * @param {{currentPeriodStartMs: number|null, currentPeriodEndMs: number|null}} period
     * @param {number} [statusToSet] — status to write (defaults to ACTIVE). A
     *   charge on an already-cancelled/completed subscription passes the terminal
     *   status so a final-cycle charge never resurrects it to ACTIVE.
     */
    static async applyActivation(subscription, period, statusToSet = subscriptionStatuses.ACTIVE)
    {
        if (!subscription)
        {
            return { applied: false };
        }

        const { currentPeriodStartMs, currentPeriodEndMs } = period || {};
        const userId = subscription.getUserId();
        const tier = subscription.getPlanTier();

        // Extend entitlement to current_end — never shorten. A late or
        // out-of-order event whose current_end is behind the stored one leaves
        // the further-out expiry untouched.
        const AuthenticationQueryEngine = require("../Database/AuthenticationQueryEngine");
        const existingUser = await AuthenticationQueryEngine.getUserById(userId);
        const existingExpiry = existingUser ? PlanTierResolver.getExpiresAt(existingUser) : null;
        const proposedExpiry = (currentPeriodEndMs !== null && currentPeriodEndMs !== undefined)
            ? Number(currentPeriodEndMs)
            : existingExpiry;
        const effectiveExpiry = (existingExpiry !== null && proposedExpiry !== null)
            ? Math.max(existingExpiry, proposedExpiry)
            : (proposedExpiry !== null ? proposedExpiry : existingExpiry);

        await PlanSubscriptionService.#applyEntitlement(userId,
        {
            planTier: tier,
            planExpiresAt: effectiveExpiry,
            planStatus: statusToSet,
            planSubscriptionId: subscription.getProviderSubscriptionId()
        });

        await UserSubscriptionQueryEngine.patchByProviderSubscriptionId(subscription.getProviderSubscriptionId(),
        {
            status: statusToSet,
            currentPeriodStartAt: (currentPeriodStartMs !== null && currentPeriodStartMs !== undefined) ? currentPeriodStartMs : subscription.getCurrentPeriodStartAt(),
            currentPeriodEndAt: (currentPeriodEndMs !== null && currentPeriodEndMs !== undefined) ? currentPeriodEndMs : subscription.getCurrentPeriodEndAt()
        });

        return { applied: true };
    }

    /**
     * Applies a successful billing cycle: grants that cycle's monthly credits
     * (idempotent on the Razorpay payment id) then activates/extends the plan.
     * Called by the subscription.charged webhook — the authoritative money
     * event. Razorpay's webhook retries re-use the same payment id, so the
     * ledger's unique referenceKey makes replays a no-op.
     *
     * @param {UserSubscription} subscription
     * @param {{razorpayPaymentId: string, currentPeriodStartMs: number|null, currentPeriodEndMs: number|null}} cycle
     */
    static async applyChargedCycle(subscription, cycle)
    {
        if (!subscription)
        {
            return { applied: false };
        }

        const { razorpayPaymentId, currentPeriodStartMs, currentPeriodEndMs } = cycle || {};
        const tier = subscription.getPlanTier();

        // A refund for this exact charge may already have arrived. Razorpay
        // delivers `subscription.charged` and `refund.processed` independently,
        // so "refunded before we ever provisioned it" is an ordinary ordering,
        // not a pathological one — and provisioning anyway would leave an
        // account paid, refunded and fully active, which is precisely the state
        // the reversal exists to prevent. Required lazily: PaymentReversalService
        // reaches back into this class to roll entitlement back, so a top-level
        // require would be a cycle.
        const PaymentReversalService = require("../Payments/PaymentReversalService");
        if (await PaymentReversalService.hasReversalForPayment(razorpayPaymentId))
        {
            console.warn(`[PlanSubscriptionService] Refusing to provision subscription charge ${razorpayPaymentId} — it has already been reversed.`);
            return { applied: false, refusedAsReversed: true };
        }

        const monthlyCredits = PlanMetadata.getMonthlyCredits(tier);
        if (monthlyCredits > 0 && razorpayPaymentId)
        {
            await CreditLedger.grant
            (
                subscription.getUserId(),
                monthlyCredits,
                creditTransactionTypes.SUBSCRIPTION_GRANT,
                `subscription:${subscription.getProviderSubscriptionId()}:${razorpayPaymentId}`,
                {
                    planTier: tier,
                    providerSubscriptionId: subscription.getProviderSubscriptionId(),
                    providerPaymentId: razorpayPaymentId
                }
            );
        }

        // A charge on a subscription the user already cancelled (or that has
        // completed its cycles) still grants that cycle's credits and extends
        // access, but must NOT resurrect it to ACTIVE — preserve the terminal
        // status so "not renewing" is not silently undone.
        const currentStatus = subscription.getStatus();
        const statusToSet = (currentStatus === subscriptionStatuses.CANCELLED || currentStatus === subscriptionStatuses.COMPLETED)
            ? currentStatus
            : subscriptionStatuses.ACTIVE;

        return await PlanSubscriptionService.applyActivation(subscription, { currentPeriodStartMs: currentPeriodStartMs, currentPeriodEndMs: currentPeriodEndMs }, statusToSet);
    }

    /**
     * Rolls entitlement back to where the reversed cycle started.
     *
     * This is the ONLY path in this class allowed to SHORTEN planExpiresAt.
     * Everywhere else the never-shorten rule protects a paying customer from a
     * late or out-of-order webhook cutting their access; here the customer has
     * taken the money back, so honouring the period that charge bought would
     * mean giving away exactly what was refunded.
     *
     * The new expiry is the cycle's START, not "now": the cycle was paid for by
     * the charge that has just been reversed, so none of it survives. Any
     * expiry EARLIER than that is left alone — a subscription already lapsed
     * for another reason must not be silently extended by a reversal.
     *
     * Status becomes CANCELLED. A reversed charge is not a payment failure
     * awaiting retry (that is PENDING/HALTED, which deliberately preserve
     * access); it is a customer who has undone the transaction.
     *
     * @param {UserSubscription} subscription
     * @returns {Promise<{applied: boolean}>}
     */
    static async applyChargeReversal(subscription)
    {
        if (!subscription)
        {
            return { applied: false };
        }

        const userId = subscription.getUserId();
        const cycleStartAt = subscription.getCurrentPeriodStartAt();

        const AuthenticationQueryEngine = require("../Database/AuthenticationQueryEngine");
        const existingUser = await AuthenticationQueryEngine.getUserById(userId);
        const existingExpiry = existingUser ? PlanTierResolver.getExpiresAt(existingUser) : null;

        const cycleStartMilliseconds = (cycleStartAt !== null && cycleStartAt !== undefined) ? Number(cycleStartAt) : null;

        // Take the EARLIER of the two. A stored expiry already behind the cycle
        // start means access had ended for some other reason, and moving it
        // forward would turn a reversal into an extension.
        const rolledBackExpiry = (existingExpiry !== null && cycleStartMilliseconds !== null)
            ? Math.min(existingExpiry, cycleStartMilliseconds)
            : (cycleStartMilliseconds !== null ? cycleStartMilliseconds : existingExpiry);

        await PlanSubscriptionService.#applyEntitlement(userId,
        {
            planExpiresAt: rolledBackExpiry,
            planStatus: subscriptionStatuses.CANCELLED
        });

        await UserSubscriptionQueryEngine.patchByProviderSubscriptionId(subscription.getProviderSubscriptionId(),
        {
            status: subscriptionStatuses.CANCELLED
        });

        return { applied: true };
    }

    /**
     * Sets subscription status WITHOUT touching entitlement expiry. Used for
     * grace states (halted / pending) and for cancelled / completed — the plan
     * is honoured until planExpiresAt regardless, then read-time expiry drops it
     * to FREE. Only the mirror planStatus is updated.
     * @param {UserSubscription} subscription
     * @param {number} status — SubscriptionStatuses value
     */
    static async applyStatus(subscription, status)
    {
        if (!subscription)
        {
            return;
        }
        await UserSubscriptionQueryEngine.patchByProviderSubscriptionId(subscription.getProviderSubscriptionId(), { status: Number(status) });
        await PlanSubscriptionService.#applyEntitlement(subscription.getUserId(), { planStatus: Number(status) });
    }
}

module.exports = PlanSubscriptionService;
