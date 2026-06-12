const crypto = require("crypto");
const DatabaseConnector = require("./DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");

/**
 * PendingOrderQueryEngine
 *
 * Server-authoritative binding between a payment-provider order id and the
 * exact deckIds + amount that order was created for. Written when a paid
 * checkout is initiated (InitiatePurchase) and read back when the payment is
 * verified (VerifyPurchase), so license grants are driven by the server's
 * record of what was ordered — NOT by client-supplied deckIds, which a buyer
 * could otherwise swap for more expensive decks after paying for a cheap one.
 *
 * A unique index on providerOrderId makes initiation idempotent; a single
 * PENDING -> CONSUMED transition (markConsumed) guards a verified payment from
 * being replayed to re-grant licenses. A TTL index prunes abandoned checkouts.
 */
class PendingOrderQueryEngine
{
    static #COLLECTION_NAME = DatabaseConstants.PENDING_ORDERS_COLLECTION;

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

        const collection = database.collection(PendingOrderQueryEngine.#COLLECTION_NAME);

        if (!PendingOrderQueryEngine.#indexesEnsured)
        {
            try
            {
                await collection.createIndex({ providerOrderId: 1 }, { unique: true });
                await collection.createIndex
                (
                    { createdAt: 1 },
                    { expireAfterSeconds: PendingOrderQueryEngine.#RETENTION_DAYS * 24 * 60 * 60 }
                );
                PendingOrderQueryEngine.#indexesEnsured = true;
            }
            catch (indexError)
            {
                console.error("[PendingOrderQueryEngine] Failed to ensure indexes:", indexError);
            }
        }

        return collection;
    }

    /**
     * Persists the (providerOrderId -> userId, deckIds, amount) binding at
     * checkout initiation. Upsert on providerOrderId so a retried initiation
     * for the same order overwrites cleanly rather than duplicating.
     */
    static async createPendingOrder({ providerOrderId, userId, deckIds, amountMinor, currency, region, paymentProvider } = {})
    {
        const collection = await PendingOrderQueryEngine.#getCollection();
        if (!collection || typeof providerOrderId !== "string" || providerOrderId.length === 0)
        {
            return null;
        }

        const safeDeckIds = Array.isArray(deckIds)
            ? deckIds.filter(deckId => typeof deckId === "string" && deckId.length > 0)
            : [];

        const row =
        {
            id: crypto.randomUUID(),
            providerOrderId: providerOrderId,
            userId: userId,
            deckIds: safeDeckIds,
            amountMinor: Number(amountMinor) || 0,
            currency: typeof currency === "string" ? currency : "INR",
            // region is a Regions enum NAME (string, e.g. "INDIA"); a number is
            // also accepted defensively. Stored verbatim so VerifyPurchase prices
            // against the exact region the buyer was charged in.
            region: (typeof region === "string" || typeof region === "number") ? region : null,
            paymentProvider: paymentProvider !== undefined ? paymentProvider : null,
            status: PendingOrderQueryEngine.STATUS_PENDING,
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
        const collection = await PendingOrderQueryEngine.#getCollection();
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
     * { transitioned: false }, so licenses are granted exactly once.
     */
    static async markConsumed(providerOrderId, userId)
    {
        const collection = await PendingOrderQueryEngine.#getCollection();
        if (!collection || typeof providerOrderId !== "string" || providerOrderId.length === 0)
        {
            return { transitioned: false };
        }

        const result = await collection.updateOne
        (
            { providerOrderId: providerOrderId, userId: userId, status: PendingOrderQueryEngine.STATUS_PENDING },
            { $set: { status: PendingOrderQueryEngine.STATUS_CONSUMED, consumedAt: new Date() } }
        );

        return { transitioned: (result.modifiedCount || 0) > 0 };
    }
}

module.exports = PendingOrderQueryEngine;
