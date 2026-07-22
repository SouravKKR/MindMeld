const crypto = require("crypto");
const DatabaseConnector = require("./DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");

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
 */
class PendingCreditOrderQueryEngine
{
    static #COLLECTION_NAME = DatabaseConstants.PENDING_CREDIT_ORDERS_COLLECTION;

    static STATUS_PENDING = "PENDING";
    static STATUS_CONSUMED = "CONSUMED";

    // Abandoned / never-completed checkouts are pruned this many days after
    // creation by a TTL index on createdAt.
    static #RETENTION_DAYS = 7;

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
                await collection.createIndex
                (
                    { createdAt: 1 },
                    { expireAfterSeconds: PendingCreditOrderQueryEngine.#RETENTION_DAYS * 24 * 60 * 60 }
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
    static async createPendingCreditOrder({ providerOrderId, userId, credits, amountMinor, currency, region, unitPrice, discountPercent, paymentProvider, couponId, couponDiscountMinor } = {})
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
