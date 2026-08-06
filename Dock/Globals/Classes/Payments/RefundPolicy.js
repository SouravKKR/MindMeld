/**
 * RefundPolicy
 *
 * CogniumLearn does not offer refunds. This class is the single place that fact
 * lives in code, so every other module can ask rather than assume.
 *
 * ── Why a policy needs code at all ────────────────────────────────────────
 *
 * "We do not give refunds" is a commercial decision, and it would be easy to
 * treat it as purely a matter for the published terms. It is not, for two
 * reasons that pull in opposite directions:
 *
 *   1. Nothing in this application may ISSUE a refund. A working refund method
 *      sitting unused is how a policy erodes — some future endpoint wires it up
 *      for a sympathetic support case, and now there is an unaudited,
 *      unapproved path that moves money out. So the provider refund
 *      implementations were deleted outright and PaymentProvider.refund()
 *      refuses for every provider. The policy is enforced by absence.
 *
 *   2. A refund can still HAPPEN. Not offering refunds does not stop a card
 *      network forcing a chargeback, a bank reversing a payment, or someone
 *      with dashboard access issuing one by hand. The handbook's G1/G2 concern
 *      is exactly this: money going back while the goods stay granted. So the
 *      application must still LISTEN, and it must treat what it hears as an
 *      exception rather than a routine lifecycle event.
 *
 * The result is asymmetric on purpose: refunds are unissuable from inside, and
 * loudly handled when they arrive from outside. Marking the refund webhook
 * "not applicable, we don't do refunds" would have been the tempting reading of
 * the policy and the wrong one — it is precisely because refunds are never
 * legitimate here that an observed refund is worth an alert.
 *
 * ── What happens when one arrives ─────────────────────────────────────────
 *
 * PaymentReversalService reverses the entitlement the payment bought. Under a
 * no-refund policy that is the only coherent response: the money has gone back,
 * so the goods must too. The alternative — money returned and access retained —
 * is a loss with no upside, and it is the outcome the policy exists to avoid.
 */
class RefundPolicy
{
    // Whether this application ever issues a refund of its own accord. Fixed
    // false; it is a constant rather than configuration because making it
    // switchable would imply an untested code path behind the "true" branch.
    static REFUNDS_OFFERED = false;

    // Razorpay's refund lifecycle events. Both are subscribed: `created` is the
    // earliest warning, `processed` is the confirmation that money actually
    // moved. Handling only `processed` would delay detection by however long
    // the provider takes to settle it.
    static REFUND_EVENT_NAMES = new Set(["refund.created", "refund.processed", "refund.failed"]);

    // The event that means money has definitively left the merchant account.
    // Only this one reverses an entitlement; the others alert and record.
    static REFUND_SETTLED_EVENT_NAME = "refund.processed";

    /**
     * @param {string} eventName
     * @returns {boolean} whether this is a refund lifecycle event
     */
    static isRefundEvent(eventName)
    {
        return RefundPolicy.REFUND_EVENT_NAMES.has(eventName);
    }

    /**
     * @param {string} eventName
     * @returns {boolean} whether this event means the money has actually moved back
     */
    static isSettledRefundEvent(eventName)
    {
        return eventName === RefundPolicy.REFUND_SETTLED_EVENT_NAME;
    }

    /**
     * The message used when something asks this application to issue a refund.
     * Kept here so the wording is identical wherever the refusal surfaces.
     * @returns {string}
     */
    static describeRefusal()
    {
        return "This application does not issue refunds. A refund observed on the payment provider is treated as an exception and reverses the entitlement it paid for.";
    }
}

module.exports = RefundPolicy;
