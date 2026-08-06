const RefundPolicy = require("./RefundPolicy");

class PaymentProvider
{
    // The smallest chargeable amount any provider will accept (100 minor units
    // = 1 major unit). Below this the order is rejected remotely.
    static MINIMUM_TRANSACTION_MINOR_UNITS = 100;

    // A sanity ceiling on any single transaction, in minor units — 10,000,000
    // minor units is 100,000 major units (e.g. 1,00,000 rupees). No legitimate
    // credit top-up or deck basket in this product approaches it. Its purpose
    // is to turn an arithmetic-manipulation attempt (A3) or a pricing-table
    // defect into a clean local rejection instead of a remote provider error
    // raised after the request has already left our control.
    static MAXIMUM_TRANSACTION_MINOR_UNITS = 10000000;

    /**
     * Whether an amount is a safe integer inside the chargeable band. Every
     * caller must clear this before an order is created remotely.
     * @param {number} amountMinor
     * @returns {boolean}
     */
    static isChargeableAmount(amountMinor)
    {
        return Number.isSafeInteger(amountMinor)
            && amountMinor >= PaymentProvider.MINIMUM_TRANSACTION_MINOR_UNITS
            && amountMinor <= PaymentProvider.MAXIMUM_TRANSACTION_MINOR_UNITS;
    }

    getProviderEnumValue()
    {
        throw new Error("PaymentProvider.getProviderEnumValue() must be implemented by subclass");
    }

    isConfigured()
    {
        throw new Error("PaymentProvider.isConfigured() must be implemented by subclass");
    }

    async initiateOrder(amountMinor, currency, metadata)
    {
        throw new Error("PaymentProvider.initiateOrder() must be implemented by subclass");
    }

    /**
     * Rebuilds the client-side checkout context for an order that was created
     * earlier, so a payment can be resumed without storing the context — which
     * would mean keeping provider key material on a database row that has no
     * business holding it.
     *
     * @param {{ providerOrderId: string, amountMinor: number, currency: string }} order
     * @returns {object|null} the context, or null when the provider is not configured
     */
    buildCheckoutContext(order)
    {
        throw new Error("PaymentProvider.buildCheckoutContext() must be implemented by subclass");
    }

    async verifyPayment(payload)
    {
        throw new Error("PaymentProvider.verifyPayment() must be implemented by subclass");
    }

    /**
     * The payments the provider recorded against an order. Used by
     * reconciliation, which has to PULL the truth for orders no push ever
     * settled. A provider that cannot answer this cannot be reconciled, so it
     * is part of the contract rather than an optional extra.
     *
     * @param {string} providerOrderId
     * @returns {Promise<Array<object>>}
     */
    async fetchOrderPayments(providerOrderId)
    {
        throw new Error("PaymentProvider.fetchOrderPayments() must be implemented by subclass");
    }

    /**
     * The captured payment for an order, or null. Captured specifically —
     * authorized-but-uncaptured must never provision (C5).
     *
     * @param {string} providerOrderId
     * @returns {Promise<object|null>}
     */
    async fetchCapturedPaymentForOrder(providerOrderId)
    {
        throw new Error("PaymentProvider.fetchCapturedPaymentForOrder() must be implemented by subclass");
    }

    /**
     * Every payment the provider recorded in a time window, regardless of which
     * order it belongs to. This is the difference between order-by-order repair
     * and RECONCILIATION: fetchOrderPayments can only ever confirm orders this
     * server already knows about, so it is structurally blind to a payment that
     * exists at the provider and nowhere here. Only a window query can find
     * money that arrived against nothing.
     *
     * @param {number} fromEpochSeconds inclusive
     * @param {number} toEpochSeconds inclusive
     * @returns {Promise<Array<object>>} provider payment entities
     */
    async fetchPaymentsInWindow(fromEpochSeconds, toEpochSeconds)
    {
        throw new Error("PaymentProvider.fetchPaymentsInWindow() must be implemented by subclass");
    }

    /**
     * Refunds are not offered by this product, so no provider implements this.
     * The base class refuses rather than leaving an abstract method a future
     * subclass might quietly fill in — see RefundPolicy for why the refusal
     * lives in code rather than only in the published terms.
     *
     * The wording comes from RefundPolicy rather than being repeated here, so
     * the policy has exactly one statement of itself.
     */
    async refund(paymentId, amountMinor)
    {
        throw new Error(RefundPolicy.describeRefusal());
    }

    // Whether this provider implements the recurring-subscription methods
    // (createPlan / createSubscription / verifySubscriptionPayment /
    // cancelSubscription). False here so one-time-only providers need not
    // implement them; a subclass that supports auto-debit overrides to true.
    supportsRecurringSubscriptions()
    {
        return false;
    }
}

module.exports = PaymentProvider;
