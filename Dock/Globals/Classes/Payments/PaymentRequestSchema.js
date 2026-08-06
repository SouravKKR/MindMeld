/**
 * PaymentRequestSchema
 *
 * Rejects a payment request body carrying any field the endpoint does not
 * accept, instead of quietly ignoring it (handbook control 18, [A1]).
 *
 * ── Why bother, when no amount is ever read from a body ───────────────────
 *
 * Amount tampering is already structurally impossible here: no payment handler
 * reads a price, quantity-derived total or currency amount from a request. So
 * an injected `amount` field has nothing to influence, and this class stops no
 * live attack today.
 *
 * It is worth having anyway, for one reason: silence is a bad failure mode for
 * a money endpoint. An ignored field looks identical to an accepted one from
 * the outside, so a caller probing for `amount`, `price`, `userId` or
 * `isPaid` gets exactly the same response as a legitimate request and learns
 * nothing either way — which also means WE learn nothing about the probe. More
 * practically, it is a standing guarantee for future changes: the day someone
 * adds a field read from the body, every unrecognised sibling is already being
 * refused rather than tolerated by habit.
 *
 * ── Why an allowlist rather than a denylist ───────────────────────────────
 *
 * A denylist has to predict the field name an attacker chooses. An allowlist
 * only has to know what the endpoint uses, which is knowable exactly by reading
 * it — and the lists below were built that way, endpoint by endpoint, including
 * fields the handler reads and then deliberately ignores (a client may still
 * send `paymentProvider` on a verify call; the server resolves the provider
 * from its own row regardless).
 *
 * Unknown-field rejection is deliberately the ONLY thing checked here. Types,
 * ranges and business rules stay in the handlers where their errors can be
 * specific — a shared validator that tried to own those would drift from the
 * logic it was meant to guard.
 */
class PaymentRequestSchema
{
    // Fields every payment body may carry regardless of endpoint. Region hints
    // are resolved by the same cascade everywhere, and a client is allowed to
    // name a provider even where the server overrides it.
    static COMMON_FIELDS = ["region", "localeRegionHint", "paymentProvider"];

    // The three fields a provider hands back to the browser after a payment.
    static VERIFICATION_FIELDS = ["providerOrderId", "providerPaymentId", "signature"];

    static SCHEMAS = new Map
    ([
        ["/Credits/Purchase/Initiate", ["credits", "couponCode"]],
        ["/Credits/Purchase/Verify", [...PaymentRequestSchema.VERIFICATION_FIELDS]],
        ["/PaidDecks/Purchase/Initiate", ["deckIds", "useMonthlyFreeDeckClaim"]],
        ["/PaidDecks/Purchase/Verify", [...PaymentRequestSchema.VERIFICATION_FIELDS]],
        ["/Subscription/Initiate", ["planTier", "couponCode"]],
        ["/Subscription/Verify", ["providerSubscriptionId", "providerPaymentId", "signature"]],
        ["/Subscription/Change", ["planTier"]],
        // The organization deal verify leg names the organization it is settling
        // into, which the handler re-checks against the stored deal's target —
        // so the field identifies, it never authorises.
        ["/Organization/Credits/Deals/Verify", ["organizationId", ...PaymentRequestSchema.VERIFICATION_FIELDS]]
    ]);

    /**
     * The field names an endpoint accepts, or null when it has no schema.
     * @param {string} routePath
     * @returns {Set<string>|null}
     */
    static getAllowedFields(routePath)
    {
        const endpointFields = PaymentRequestSchema.SCHEMAS.get(routePath);
        if (!endpointFields)
        {
            return null;
        }

        return new Set([...endpointFields, ...PaymentRequestSchema.COMMON_FIELDS]);
    }

    /**
     * Every field in the body that the endpoint does not accept.
     *
     * A non-object body (null, an array, a string) yields no unexpected fields:
     * it is not this class's job to police the body's TYPE, and returning a
     * spurious rejection here would mask the handler's own clearer error.
     *
     * @param {string} routePath
     * @param {*} body
     * @returns {Array<string>} the offending field names, empty when acceptable
     */
    static findUnexpectedFields(routePath, body)
    {
        const allowedFields = PaymentRequestSchema.getAllowedFields(routePath);
        if (!allowedFields)
        {
            return [];
        }

        if (body === null || typeof body !== "object" || Array.isArray(body))
        {
            return [];
        }

        return Object.keys(body).filter(fieldName => !allowedFields.has(fieldName));
    }
}

module.exports = PaymentRequestSchema;
