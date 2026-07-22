const UserSubscriptionQueryEngine = require("../Database/UserSubscriptionQueryEngine");
const PlanSubscriptionService = require("./PlanSubscriptionService");
const { subscriptionStatuses } = require("../../Enumerations/SubscriptionStatuses");
const ErrorCodes = require("../../Constants/ErrorCodes");

// Turns a verified Razorpay subscription webhook into plan side effects. Keeps
// the webhook route a thin dispatcher. Every path is idempotent (credit grants
// via the ledger's referenceKey; entitlement writes are last-write-wins with a
// never-shorten guard), so Razorpay's ~5 retries per event are safe.

class SubscriptionWebhookProcessor
{
    // Razorpay timestamps are UNIX SECONDS — convert to milliseconds. Missing
    // this ×1000 would land planExpiresAt in 1970.
    static #toMilliseconds(unixSeconds)
    {
        if (unixSeconds === null || unixSeconds === undefined)
        {
            return null;
        }
        const numeric = Number(unixSeconds);
        return isNaN(numeric) ? null : numeric * 1000;
    }

    static isSubscriptionEvent(eventName)
    {
        return typeof eventName === "string" && eventName.startsWith("subscription.");
    }

    /**
     * @param {string} eventName
     * @param {object} payload — the parsed Razorpay webhook body
     * @returns {Promise<{handled: boolean, applied?: string, reason?: string}>}
     */
    static async process(eventName, payload)
    {
        const subscriptionEntity = payload?.payload?.subscription?.entity;
        const providerSubscriptionId = subscriptionEntity?.id || "";
        if (!providerSubscriptionId)
        {
            return { handled: true, reason: ErrorCodes.MISSING_FIELDS };
        }

        const subscription = await UserSubscriptionQueryEngine.getByProviderSubscriptionId(providerSubscriptionId);
        if (!subscription)
        {
            return { handled: true, reason: ErrorCodes.SUBSCRIPTION_NOT_FOUND };
        }

        const currentPeriodStartMs = SubscriptionWebhookProcessor.#toMilliseconds(subscriptionEntity?.current_start);
        const currentPeriodEndMs = SubscriptionWebhookProcessor.#toMilliseconds(subscriptionEntity?.current_end);

        switch (eventName)
        {
            case "subscription.authenticated":
            case "subscription.activated":
                await PlanSubscriptionService.applyActivation(subscription, { currentPeriodStartMs: currentPeriodStartMs, currentPeriodEndMs: currentPeriodEndMs });
                return { handled: true, applied: "ACTIVATION" };

            case "subscription.charged":
            {
                // The authoritative money event — grant this cycle's credits
                // idempotently on the charge payment id, then extend entitlement.
                const razorpayPaymentId = payload?.payload?.payment?.entity?.id || "";
                await PlanSubscriptionService.applyChargedCycle(subscription, { razorpayPaymentId: razorpayPaymentId, currentPeriodStartMs: currentPeriodStartMs, currentPeriodEndMs: currentPeriodEndMs });
                return { handled: true, applied: "CHARGED" };
            }

            case "subscription.pending":
                // A charge failed; Razorpay will retry. GRACE — do NOT shorten
                // planExpiresAt; the user keeps access through the retry window.
                await PlanSubscriptionService.applyStatus(subscription, subscriptionStatuses.PENDING);
                return { handled: true, applied: "PENDING" };

            case "subscription.halted":
                // Retries exhausted. Still GRACE at the entitlement level — access
                // holds until planExpiresAt, then read-time expiry drops to FREE.
                await PlanSubscriptionService.applyStatus(subscription, subscriptionStatuses.HALTED);
                return { handled: true, applied: "HALTED" };

            case "subscription.cancelled":
                await PlanSubscriptionService.applyStatus(subscription, subscriptionStatuses.CANCELLED);
                return { handled: true, applied: "CANCELLED" };

            case "subscription.completed":
                await PlanSubscriptionService.applyStatus(subscription, subscriptionStatuses.COMPLETED);
                return { handled: true, applied: "COMPLETED" };

            default:
                return { handled: false, reason: "EVENT_IGNORED" };
        }
    }
}

module.exports = SubscriptionWebhookProcessor;
