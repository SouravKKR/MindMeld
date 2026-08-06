const crypto = require("crypto");
const DatabaseConnector = require("./DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const TimeToLiveIndexReconciler = require("./TimeToLiveIndexReconciler");

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
 *
 * Two independent paths can settle the same order — the buyer's browser
 * (/PaidDecks/Purchase/Verify) and the payment-provider webhook — so
 * tryClaimForGrant serializes them: exactly one caller wins the claim and runs
 * the (non-atomic, multi-collection) license grant while the other returns an
 * idempotent "already handled". A claim goes stale after
 * GRANT_CLAIM_STALE_MILLISECONDS so a holder that crashed mid-grant never
 * strands a paid order — the row is still PENDING, and the next caller retries.
 */
class PendingOrderQueryEngine
{
    static #COLLECTION_NAME = DatabaseConstants.PENDING_ORDERS_COLLECTION;

    static STATUS_PENDING = "PENDING";
    static STATUS_CONSUMED = "CONSUMED";

    // See PendingCreditOrderQueryEngine for the reasoning; kept identical so a
    // retry behaves the same whichever thing the buyer is buying.
    static REUSABLE_ORDER_WINDOW_MILLISECONDS = 30 * 60 * 1000;

    // How long a grant claim is honoured before another caller may take it
    // over. Must comfortably exceed the slowest realistic grant (seeding a
    // large deck's entities into the buyer's collections), because taking a
    // claim over from a still-running holder re-introduces the concurrent-seed
    // race the claim exists to prevent.
    static GRANT_CLAIM_STALE_MILLISECONDS = 10 * 60 * 1000;

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

        const collection = database.collection(PendingOrderQueryEngine.#COLLECTION_NAME);

        if (!PendingOrderQueryEngine.#indexesEnsured)
        {
            try
            {
                await collection.createIndex({ providerOrderId: 1 }, { unique: true });
                // Backs findReusableByReceipt. Not unique — see the note in
                // PendingCreditOrderQueryEngine.
                await collection.createIndex({ userId: 1, receiptId: 1, status: 1 });
                // Through the reconciler, not createIndex directly: raising
                // the retention on a collection whose TTL index already exists
                // is an IndexOptionsConflict, which the catch below would
                // swallow — leaving the OLD expiry silently in force.
                await TimeToLiveIndexReconciler.ensure
                (
                    database,
                    DatabaseConstants.PENDING_ORDERS_COLLECTION,
                    { createdAt: 1 },
                    PendingOrderQueryEngine.#RETENTION_DAYS * 24 * 60 * 60
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
    static async createPendingOrder({ providerOrderId, userId, deckIds, amountMinor, currency, region, paymentProvider, receiptId } = {})
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
            // Deterministic receipt (CheckoutReceiptIdentifier) — the retry key.
            receiptId: (typeof receiptId === "string" && receiptId.length > 0) ? receiptId : null,
            status: PendingOrderQueryEngine.STATUS_PENDING,
            createdAt: new Date(),
            consumedAt: new Date(0),
            // Epoch = unclaimed. Set by tryClaimForGrant while a settlement path
            // is granting this order's licenses.
            grantClaimedAt: new Date(0)
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
        const collection = await PendingOrderQueryEngine.#getCollection();
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
                status: PendingOrderQueryEngine.STATUS_PENDING
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
        const collection = await PendingOrderQueryEngine.#getCollection();
        if (!collection || typeof receiptId !== "string" || receiptId.length === 0 || !userId)
        {
            return { deleted: false };
        }

        const result = await collection.deleteOne
        ({
            providerOrderId: receiptId,
            receiptId: receiptId,
            userId: userId,
            status: PendingOrderQueryEngine.STATUS_PENDING
        });

        return { deleted: (result.deletedCount || 0) > 0 };
    }

    /**
     * The most recent unpaid order this buyer created for exactly this basket,
     * or null. Because the amount and currency are inputs to the receipt, a row
     * found here is provably for the same decks at the same price, so it can be
     * handed back without re-pricing.
     *
     * @param {string} receiptId — from CheckoutReceiptIdentifier
     * @param {string} userId
     * @param {number} [nowMilliseconds]
     * @returns {Promise<object|null>}
     */
    static async findReusableByReceipt(receiptId, userId, nowMilliseconds = Date.now())
    {
        const collection = await PendingOrderQueryEngine.#getCollection();
        if (!collection || typeof receiptId !== "string" || receiptId.length === 0 || !userId)
        {
            return null;
        }

        return await collection.findOne
        (
            {
                receiptId: receiptId,
                userId: userId,
                status: PendingOrderQueryEngine.STATUS_PENDING,
                createdAt: { $gte: new Date(nowMilliseconds - PendingOrderQueryEngine.REUSABLE_ORDER_WINDOW_MILLISECONDS) }
            },
            { projection: { _id: 0 }, sort: { createdAt: -1 } }
        );
    }

    /**
     * Atomically claims the right to grant this order's licenses. Only the
     * caller that receives { claimed: true } may run the grant; a concurrent
     * settlement path (browser verify vs provider webhook) receives
     * { claimed: false } and must treat the order as handled elsewhere.
     *
     * A row already CONSUMED never yields a claim, so this doubles as the
     * replay guard. An existing claim older than GRANT_CLAIM_STALE_MILLISECONDS
     * is treated as abandoned and taken over — every grant write is an
     * idempotent upsert / re-seed, so a retry after a crash converges.
     */
    static async tryClaimForGrant(providerOrderId, userId)
    {
        const collection = await PendingOrderQueryEngine.#getCollection();
        if (!collection || typeof providerOrderId !== "string" || providerOrderId.length === 0)
        {
            return { claimed: false };
        }

        const staleThreshold = new Date(Date.now() - PendingOrderQueryEngine.GRANT_CLAIM_STALE_MILLISECONDS);

        const result = await collection.updateOne
        (
            {
                providerOrderId: providerOrderId,
                userId: userId,
                status: PendingOrderQueryEngine.STATUS_PENDING,
                // Unclaimed rows store the epoch sentinel; rows written before
                // claiming existed carry no field at all. Both are claimable,
                // as is any claim that has gone stale.
                $or:
                [
                    { grantClaimedAt: { $exists: false } },
                    { grantClaimedAt: null },
                    { grantClaimedAt: { $lte: staleThreshold } }
                ]
            },
            { $set: { grantClaimedAt: new Date() } }
        );

        return { claimed: (result.modifiedCount || 0) > 0 };
    }

    /**
     * Returns a claim so another settlement path can retry immediately. Called
     * when a claimed grant fails before the order is consumed — without it the
     * order would be untouchable until the claim went stale.
     */
    static async releaseGrantClaim(providerOrderId, userId)
    {
        const collection = await PendingOrderQueryEngine.#getCollection();
        if (!collection || typeof providerOrderId !== "string" || providerOrderId.length === 0)
        {
            return { released: false };
        }

        const result = await collection.updateOne
        (
            { providerOrderId: providerOrderId, userId: userId, status: PendingOrderQueryEngine.STATUS_PENDING },
            { $set: { grantClaimedAt: new Date(0) } }
        );

        return { released: (result.modifiedCount || 0) > 0 };
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
