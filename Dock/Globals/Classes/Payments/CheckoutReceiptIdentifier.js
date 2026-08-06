const crypto = require("crypto");

/**
 * CheckoutReceiptIdentifier
 *
 * Derives the receipt a payment order is created with, deterministically, from
 * what the buyer is actually buying.
 *
 * The handbook asks for a deterministic receipt so a retried initiation maps to
 * ONE logical order. Before this class the receipt embedded Date.now(), so a
 * double-click produced two unrelated provider orders with nothing to say they
 * were the same intent — the buyer sees one checkout, the dashboard shows two
 * orders, and reconciliation has no way to collapse them.
 *
 * What goes into the hash is the whole point. Every input is something that,
 * if it changed, SHOULD produce a different order:
 *
 *   buyer         two people buying the same thing are not the same order
 *   purpose       a credit top-up is not a deck purchase
 *   subject       the credit quantity, or the (sorted) deck ids
 *   amount        <-- the load-bearing one, see below
 *   currency      49900 of one currency is not 49900 of another
 *   coupon        a discounted checkout is a different intent to an undiscounted one
 *
 * Including the AMOUNT is what makes reusing a matching unpaid order safe. If
 * the catalogue price, the exchange rate or the coupon changes between two
 * attempts, the receipt changes with it, so the second attempt can never be
 * served an order created at the old price. A caller may therefore treat "same
 * receipt" as "same money for the same goods" without re-checking anything.
 *
 * Deck ids are sorted before hashing so the same basket in a different order is
 * the same receipt — otherwise the client's array ordering would silently
 * become part of the identity.
 *
 * Razorpay caps the receipt field at 40 characters, so this emits a short
 * prefix plus a truncated SHA-256 digest rather than readable text. 32 hex
 * characters is 128 bits, which is far past any collision concern for the
 * number of orders this product will ever create.
 */
class CheckoutReceiptIdentifier
{
    // Razorpay rejects a receipt longer than this. Every identifier produced
    // here is well inside it; the constant exists so the assertion below has
    // something to check against rather than a magic number.
    static MAXIMUM_RECEIPT_LENGTH = 40;

    // Hex characters of digest kept. 32 = 128 bits.
    static DIGEST_CHARACTERS = 32;

    static CREDIT_PURCHASE_PREFIX = "clc_";
    static PAID_DECK_PURCHASE_PREFIX = "cld_";
    static ORGANIZATION_CREDIT_DEAL_PREFIX = "clo_";

    static #digest(parts)
    {
        const canonicalText = parts
            .map(part => (part === null || part === undefined) ? "" : String(part))
            .join("|");

        return crypto
            .createHash("sha256")
            .update(canonicalText)
            .digest("hex")
            .slice(0, CheckoutReceiptIdentifier.DIGEST_CHARACTERS);
    }

    static #build(prefix, parts)
    {
        const receiptId = `${prefix}${CheckoutReceiptIdentifier.#digest(parts)}`;

        if (receiptId.length > CheckoutReceiptIdentifier.MAXIMUM_RECEIPT_LENGTH)
        {
            // Unreachable with the current prefixes and digest length, but a
            // future prefix change must fail here rather than at the provider.
            throw new Error(`Receipt identifier exceeds ${CheckoutReceiptIdentifier.MAXIMUM_RECEIPT_LENGTH} characters: ${receiptId}`);
        }

        return receiptId;
    }

    /**
     * The receipt for a credit top-up.
     * @param {{userId: string, credits: number, amountMinor: number, currency: string, couponId: string|null}} intent
     * @returns {string}
     */
    static forCreditPurchase({ userId, credits, amountMinor, currency, couponId } = {})
    {
        return CheckoutReceiptIdentifier.#build
        (
            CheckoutReceiptIdentifier.CREDIT_PURCHASE_PREFIX,
            ["CREDIT_PURCHASE", userId, credits, amountMinor, String(currency || "").toUpperCase(), couponId || ""]
        );
    }

    /**
     * The receipt for a paid-deck basket.
     * @param {{userId: string, deckIds: Array<string>, amountMinor: number, currency: string}} intent
     * @returns {string}
     */
    static forPaidDeckPurchase({ userId, deckIds, amountMinor, currency } = {})
    {
        const sortedDeckIds = Array.isArray(deckIds)
            ? [...deckIds].filter(deckId => typeof deckId === "string" && deckId.length > 0).sort()
            : [];

        return CheckoutReceiptIdentifier.#build
        (
            CheckoutReceiptIdentifier.PAID_DECK_PURCHASE_PREFIX,
            ["PAID_DECK_PURCHASE", userId, sortedDeckIds.join(","), amountMinor, String(currency || "").toUpperCase()]
        );
    }

    /**
     * The receipt for a block of credits sold to an organization.
     *
     * The buyer here is the ORGANIZATION rather than the administrator who
     * happens to be clicking, which is what makes this a distinct method instead
     * of a reuse of the credit one: two administrators of the same institute
     * creating the same deal are creating one deal, and keying the receipt on
     * whoever acted would make them two.
     *
     * The contract term is an input because a block of credits sold to the same
     * organization at the same price for a DIFFERENT term is a different
     * commercial agreement, not a retry of the first.
     *
     * @param {{organizationId: string, credits: number, amountMinor: number, currency: string, termEndsAt: string}} intent
     * @returns {string}
     */
    static forOrganizationCreditDeal({ organizationId, credits, amountMinor, currency, termEndsAt } = {})
    {
        return CheckoutReceiptIdentifier.#build
        (
            CheckoutReceiptIdentifier.ORGANIZATION_CREDIT_DEAL_PREFIX,
            ["ORGANIZATION_CREDIT_DEAL", organizationId, credits, amountMinor, String(currency || "").toUpperCase(), termEndsAt || ""]
        );
    }
}

module.exports = CheckoutReceiptIdentifier;
