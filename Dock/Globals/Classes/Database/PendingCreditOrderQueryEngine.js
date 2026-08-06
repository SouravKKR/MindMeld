const crypto = require("crypto");
const DatabaseConnector = require("./DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const TimeToLiveIndexReconciler = require("./TimeToLiveIndexReconciler");

/**
 * PendingCreditOrderQueryEngine
 *
 * Server-authoritative binding between a payment-provider order id and the
 * exact credit quantity + amount that order was created for. Written when a
 * credit checkout is initiated (InitiateCreditPurchase) and read back when
 * the payment is verified (VerifyCreditPurchase) or captured via webhook, so
 * the grant is driven by the server's record of what was ordered — NOT by
 * client-supplied quantities, which a buyer could otherwise inflate after
 * paying for a smaller amount.
 *
 * A unique index on providerOrderId makes initiation idempotent; a single
 * PENDING -> CONSUMED transition (markConsumed) backs up the CreditLedger's
 * own referenceKey idempotency so a verified payment grants exactly once.
 * A TTL index prunes abandoned checkouts.
 *
 * Rows also carry the deterministic receipt from CheckoutReceiptIdentifier, so
 * a retried initiation for the same intent can be matched to the order the
 * first attempt already created instead of minting a second one. That lookup is
 * safe precisely because the amount and currency are inputs to the receipt: a
 * row found by receipt is guaranteed to be for the same money and the same
 * goods, so no re-validation of price is needed on reuse.
 */
class PendingCreditOrderQueryEngine
{
    static #COLLECTION_NAME = DatabaseConstants.PENDING_CREDIT_ORDERS_COLLECTION;

    static STATUS_PENDING = "PENDING";
    static STATUS_CONSUMED = "CONSUMED";

    // How recently an unpaid order must have been created to be handed back to
    // a retrying buyer. Long enough to cover a double-click, a failed card and
    // a second attempt minutes later; short enough that an order abandoned
    // hours ago is re-created rather than resurrected with a stale provider
    // session behind it.
    static REUSABLE_ORDER_WINDOW_MILLISECONDS = 30 * 60 * 1000;

    // Abandoned / never-completed checkouts are pruned this many days after
    // creation by a TTL index on createdAt.
    //
    // Raised from 7 to 14. The row is not just a checkout scratchpad: while it
    // exists it is the ONLY local evidence that a payment was attempted, so
    // deleting it destroys the starting point of any "I paid and got nothing"
    // investigation. PendingPaymentReconciler repairs such orders automatically
    // within 48 hours, but a customer may not notice or complain for days, and
    // a fortnight of history costs almost nothing against that.
    static #RETENTION_DAYS = 14;

    static #indexesEnsured = false;

    static async #getCollection()
    {
        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            return null;
        }

        const collection = database.collection(PendingCreditOrderQueryEngine.#COLLECTION_NAME);

        if (!PendingCreditOrderQueryEngine.#indexesEnsured)
        {
            try
            {
                await collection.createIndex({ providerOrderId: 1 }, { unique: true });
                // Backs the retry lookups below. Deliberately NOT unique: two
                // orders for the same receipt is exactly the state reuse
                // exists to reduce, not an integrity violation to reject —
                // rejecting it would turn a duplicate click into a failed
                // checkout.
                await collection.createIndex({ userId: 1, receiptId: 1, status: 1 });
                await collection.createIndex({ userId: 1, couponId: 1, status: 1 });
                // Through the reconciler, not createIndex directly: raising
                // the retention on a collection whose TTL index already exists
                // is an IndexOptionsConflict, which the catch below would
                // swallow — leaving the OLD expiry silently in force.
                await TimeToLiveIndexReconciler.ensure
                (
                    database,
                    DatabaseConstants.PENDING_CREDIT_ORDERS_COLLECTION,
                    { createdAt: 1 },
                    PendingCreditOrderQueryEngine.#RETENTION_DAYS * 24 * 60 * 60
                );
                PendingCreditOrderQueryEngine.#indexesEnsured = true;
            }
            catch (indexError)
            {
                console.error("[PendingCreditOrderQueryEngine] Failed to ensure indexes:", indexError);
            }
        }

        return collection;
    }

    /**
     * Persists the (providerOrderId -> userId, credits, amount) binding at
     * checkout initiation. Upsert on providerOrderId so a retried initiation
     * for the same order overwrites cleanly rather than duplicating.
     */
    static async createPendingCreditOrder({ providerOrderId, userId, credits, amountMinor, currency, region, unitPrice, discountPercent, paymentProvider, couponId, couponDiscountMinor, receiptId } = {})
    {
        const collection = await PendingCreditOrderQueryEngine.#getCollection();
        if (!collection || typeof providerOrderId !== "string" || providerOrderId.length === 0)
        {
            return null;
        }

        const safeCredits = parseInt(credits, 10);

        const row =
        {
            id: crypto.randomUUID(),
            providerOrderId: providerOrderId,
            userId: userId,
            credits: isNaN(safeCredits) || safeCredits < 0 ? 0 : safeCredits,
            amountMinor: Number(amountMinor) || 0,
            currency: typeof currency === "string" ? currency : "INR",
            // region is a Regions enum NAME (string, e.g. "INDIA"); stored for
            // the audit trail on the eventual grant.
            region: (typeof region === "string" || typeof region === "number") ? region : null,
            unitPrice: Number(unitPrice) || 0,
            discountPercent: Number(discountPercent) || 0,
            paymentProvider: paymentProvider !== undefined ? paymentProvider : null,
            // Discount coupon applied at checkout (null when none). The redemption
            // row was already reserved by CouponCheckoutService; these fields are
            // for the audit trail on the eventual grant.
            couponId: (typeof couponId === "string" && couponId.length > 0) ? couponId : null,
            couponDiscountMinor: Number(couponDiscountMinor) || 0,
            // Deterministic receipt (CheckoutReceiptIdentifier) — the retry key.
            receiptId: (typeof receiptId === "string" && receiptId.length > 0) ? receiptId : null,
            status: PendingCreditOrderQueryEngine.STATUS_PENDING,
            createdAt: new Date(),
            consumedAt: new Date(0)
        };

        await collection.updateOne
        (
            { providerOrderId: providerOrderId },
            { $set: row },
            { upsert: true }
        );

        return row;
    }

    static async getByOrderId(providerOrderId)
    {
        const collection = await PendingCreditOrderQueryEngine.#getCollection();
        if (!collection || typeof providerOrderId !== "string" || providerOrderId.length === 0)
        {
            return null;
        }

        return await collection.findOne({ providerOrderId: providerOrderId }, { projection: { _id: 0 } });
    }

    /**
     * Replaces the placeholder order id (the receipt) with the provider's real
     * one, once the remote order exists.
     *
     * The row is written before the provider is called, so between those two
     * moments it is keyed on the receipt. Scoped to the owning user and to
     * PENDING rows, so this can never re-point a row that has already settled.
     *
     * @param {string} receiptId — the placeholder the row was written under
     * @param {string} userId
     * @param {string} providerOrderId — the provider's real order id
     * @returns {Promise<{attached: boolean}>}
     */
    static async attachProviderOrderId(receiptId, userId, providerOrderId)
    {
        const collection = await PendingCreditOrderQueryEngine.#getCollection();
        if (!collection
            || typeof receiptId !== "string" || receiptId.length === 0
            || typeof providerOrderId !== "string" || providerOrderId.length === 0
            || !userId)
        {
            return { attached: false };
        }

        const result = await collection.updateOne
        (
            {
                providerOrderId: receiptId,
                userId: userId,
                status: PendingCreditOrderQueryEngine.STATUS_PENDING
            },
            { $set: { providerOrderId: providerOrderId } }
        );

        return { attached: (result.modifiedCount || 0) > 0 };
    }

    /**
     * Removes a row written before a provider call that then failed.
     *
     * Without this a failed initiation would leave a row whose providerOrderId
     * is still the receipt — an order the provider has never heard of, which
     * reconciliation would then ask about on every sweep for a fortnight.
     *
     * Deliberately narrow: it only ever deletes a PENDING row still carrying
     * its placeholder id, so it cannot remove a real order under any
     * circumstances.
     *
     * @param {string} receiptId
     * @param {string} userId
     * @returns {Promise<{deleted: boolean}>}
     */
    static async deleteUnclaimedOrder(receiptId, userId)
    {
        const collection = await PendingCreditOrderQueryEngine.#getCollection();
        if (!collection || typeof receiptId !== "string" || receiptId.length === 0 || !userId)
        {
            return { deleted: false };
        }

        const result = await collection.deleteOne
        ({
            providerOrderId: receiptId,
            receiptId: receiptId,
            userId: userId,
            status: PendingCreditOrderQueryEngine.STATUS_PENDING
        });

        return { deleted: (result.deletedCount || 0) > 0 };
    }

    /**
     * The most recent unpaid order this buyer created for exactly this intent,
     * or null. Callers hand the row's stored order straight back to the browser
     * instead of creating a second provider order for the same purchase.
     *
     * Scoped to the owning user and to the reuse window, and restricted to
     * PENDING rows so a settled order can never be re-served.
     *
     * @param {string} receiptId — from CheckoutReceiptIdentifier
     * @param {string} userId
     * @param {number} [nowMilliseconds]
     * @returns {Promise<object|null>}
     */
    static async findReusableByReceipt(receiptId, userId, nowMilliseconds = Date.now())
    {
        const collection = await PendingCreditOrderQueryEngine.#getCollection();
        if (!collection || typeof receiptId !== "string" || receiptId.length === 0 || !userId)
        {
            return null;
        }

        return await collection.findOne
        (
            {
                receiptId: receiptId,
                userId: userId,
                status: PendingCreditOrderQueryEngine.STATUS_PENDING,
                createdAt: { $gte: new Date(nowMilliseconds - PendingCreditOrderQueryEngine.REUSABLE_ORDER_WINDOW_MILLISECONDS) }
            },
            { projection: { _id: 0 }, sort: { createdAt: -1 } }
        );
    }

    /**
     * The most recent unpaid order this buyer created with a given coupon, or
     * null.
     *
     * A coupon needs its own lookup because a discount reservation is
     * once-per-user: on a retry the reservation from the FIRST attempt still
     * stands, so re-reserving would be refused as already-redeemed and the
     * buyer would be locked out of the checkout they abandoned seconds earlier.
     * Finding the existing order by coupon lets the retry reuse it without
     * touching the reservation at all. It cannot be found by receipt instead,
     * because the receipt is derived from the discounted amount, which is not
     * known until the coupon has been resolved.
     *
     * @param {string} couponId
     * @param {string} userId
     * @param {number} [nowMilliseconds]
     * @returns {Promise<object|null>}
     */
    static async findReusableByCoupon(couponId, userId, nowMilliseconds = Date.now())
    {
        const collection = await PendingCreditOrderQueryEngine.#getCollection();
        if (!collection || typeof couponId !== "string" || couponId.length === 0 || !userId)
        {
            return null;
        }

        return await collection.findOne
        (
            {
                couponId: couponId,
                userId: userId,
                status: PendingCreditOrderQueryEngine.STATUS_PENDING,
                createdAt: { $gte: new Date(nowMilliseconds - PendingCreditOrderQueryEngine.REUSABLE_ORDER_WINDOW_MILLISECONDS) }
            },
            { projection: { _id: 0 }, sort: { createdAt: -1 } }
        );
    }

    /**
     * Atomically transitions a PENDING order to CONSUMED, scoped to the owning
     * user. Returns { transitioned: true } only for the single call that
     * actually flipped the status — every later (replayed) call gets
     * { transitioned: false }.
     */
    static async markConsumed(providerOrderId, userId)
    {
        const collection = await PendingCreditOrderQueryEngine.#getCollection();
        if (!collection || typeof providerOrderId !== "string" || providerOrderId.length === 0)
        {
            return { transitioned: false };
        }

        const result = await collection.updateOne
        (
            { providerOrderId: providerOrderId, userId: userId, status: PendingCreditOrderQueryEngine.STATUS_PENDING },
            { $set: { status: PendingCreditOrderQueryEngine.STATUS_CONSUMED, consumedAt: new Date() } }
        );

        return { transitioned: (result.modifiedCount || 0) > 0 };
    }
}

module.exports = PendingCreditOrderQueryEngine;
