const crypto = require("crypto");
const DatabaseConnector = require("./DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const TimeToLiveIndexReconciler = require("./TimeToLiveIndexReconciler");
const { paymentAttemptOutcomes } = require("../../Enumerations/PaymentAttemptOutcomes");

/**
 * PaymentAttemptQueryEngine
 *
 * The record of what buyers actually tried to pay, successfully or not.
 *
 * Before this existed the application knew only about payments that WORKED. A
 * declined card produced a console line in the buyer's own browser and nothing
 * server-side — so three questions had no answer: why a customer says the
 * payment "didn't go through", whether a spike of declines is a card-testing
 * attack, and which failure reasons are costing real conversions.
 *
 * Failures are recorded from the `payment.failed` webhook rather than from the
 * browser, deliberately. The browser's version of a failure is unauthenticated,
 * omitted entirely when the buyer closes the tab, and trivially forgeable; the
 * webhook's is signed and arrives whether or not anyone is watching.
 *
 * ── Card testing ──────────────────────────────────────────────────────────
 *
 * Once failures are stored, the handbook's F1 indicator becomes computable:
 * a burst of declines against one account is what card testing looks like from
 * the merchant's side. countRecentFailures exists for exactly that, and is
 * cheap because the index it uses is the one the retention TTL already needs.
 *
 * Nothing here is on the settlement path. A write failure must never affect
 * whether a payment settles, so every method swallows its own errors — losing
 * a diagnostic row is not worth failing a customer's purchase over.
 */
class PaymentAttemptQueryEngine
{
    static #COLLECTION_NAME = DatabaseConstants.PAYMENT_ATTEMPTS_COLLECTION;
    static #RETENTION_DAYS = DatabaseConstants.PAYMENT_ATTEMPT_RETENTION_DAYS;

    // The window and count that define a decline burst. Six failures in ten
    // minutes is far past what a genuine buyer fixing a typo or switching cards
    // produces, and well short of what a card-testing script does.
    static FAILURE_BURST_WINDOW_MILLISECONDS = 10 * 60 * 1000;
    static FAILURE_BURST_THRESHOLD = 6;

    static #indexesEnsured = false;

    static async #getCollection()
    {
        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            return null;
        }

        const collection = database.collection(PaymentAttemptQueryEngine.#COLLECTION_NAME);

        if (!PaymentAttemptQueryEngine.#indexesEnsured)
        {
            try
            {
                // Partial and unique on the provider's own attempt id, so a
                // redelivered webhook records one attempt rather than several.
                // Partial because an attempt with no payment id (a failure
                // before the provider minted one) must not collide with every
                // other such attempt on a single null key.
                await collection.createIndex
                (
                    { providerPaymentId: 1 },
                    { unique: true, partialFilterExpression: { providerPaymentId: { $type: "string" } } }
                );
                await collection.createIndex({ userId: 1, attemptedAt: -1 });
                await collection.createIndex({ providerOrderId: 1 });
                // Through the reconciler, not createIndex directly: changing the
                // retention on a collection whose TTL index already exists is an
                // IndexOptionsConflict, which the catch below would swallow —
                // leaving the OLD expiry silently in force while the source
                // claimed otherwise.
                await TimeToLiveIndexReconciler.ensure
                (
                    database,
                    DatabaseConstants.PAYMENT_ATTEMPTS_COLLECTION,
                    { attemptedAt: 1 },
                    PaymentAttemptQueryEngine.#RETENTION_DAYS * 24 * 60 * 60
                );
                PaymentAttemptQueryEngine.#indexesEnsured = true;
            }
            catch (indexError)
            {
                console.error("[PaymentAttemptQueryEngine] Failed to ensure indexes:", indexError);
            }
        }

        return collection;
    }

    /**
     * Records one payment attempt.
     *
     * @param {{userId: string, providerOrderId: string, providerPaymentId: string, outcome: number, amountMinor: number, currency: string, method: string, errorCode: string, errorDescription: string, errorReason: string, errorSource: string, errorStep: string}} attempt
     * @returns {Promise<{recorded: boolean, duplicate: boolean}>}
     */
    static async record(attempt = {})
    {
        const collection = await PaymentAttemptQueryEngine.#getCollection();
        if (!collection)
        {
            return { recorded: false, duplicate: false };
        }

        const row =
        {
            id: crypto.randomUUID(),
            userId: typeof attempt.userId === "string" ? attempt.userId : "",
            providerOrderId: typeof attempt.providerOrderId === "string" ? attempt.providerOrderId : "",
            providerPaymentId: (typeof attempt.providerPaymentId === "string" && attempt.providerPaymentId.length > 0)
                ? attempt.providerPaymentId
                : null,
            outcome: Number.isInteger(attempt.outcome) ? attempt.outcome : paymentAttemptOutcomes.UNKNOWN,
            amountMinor: Number(attempt.amountMinor) || 0,
            currency: typeof attempt.currency === "string" ? attempt.currency : "",
            // The payment instrument class only (card / upi / netbanking). Never
            // an instrument identifier — nothing here may become cardholder data.
            method: typeof attempt.method === "string" ? attempt.method : "",
            // The provider's own failure taxonomy, kept verbatim so a decline can
            // be matched against the provider's documentation months later.
            errorCode: typeof attempt.errorCode === "string" ? attempt.errorCode : "",
            errorDescription: typeof attempt.errorDescription === "string" ? attempt.errorDescription : "",
            errorReason: typeof attempt.errorReason === "string" ? attempt.errorReason : "",
            errorSource: typeof attempt.errorSource === "string" ? attempt.errorSource : "",
            errorStep: typeof attempt.errorStep === "string" ? attempt.errorStep : "",
            attemptedAt: new Date()
        };

        try
        {
            await collection.insertOne(row);
            return { recorded: true, duplicate: false };
        }
        catch (insertError)
        {
            if (insertError?.code === 11000)
            {
                return { recorded: false, duplicate: true };
            }

            console.error("[PaymentAttemptQueryEngine] Failed to record a payment attempt:", insertError);
            return { recorded: false, duplicate: false };
        }
    }

    /**
     * How many failed attempts this buyer has made inside the burst window.
     * Returns 0 rather than throwing when the database is unavailable — a
     * missing signal must not break the webhook that produced it.
     *
     * @param {string} userId
     * @param {number} [nowMilliseconds]
     * @returns {Promise<number>}
     */
    static async countRecentFailures(userId, nowMilliseconds = Date.now())
    {
        const collection = await PaymentAttemptQueryEngine.#getCollection();
        if (!collection || typeof userId !== "string" || userId.length === 0)
        {
            return 0;
        }

        try
        {
            return await collection.countDocuments
            ({
                userId: userId,
                outcome: paymentAttemptOutcomes.FAILED,
                attemptedAt: { $gte: new Date(nowMilliseconds - PaymentAttemptQueryEngine.FAILURE_BURST_WINDOW_MILLISECONDS) }
            });
        }
        catch (countError)
        {
            console.error("[PaymentAttemptQueryEngine] Failed to count recent failures:", countError);
            return 0;
        }
    }

    /**
     * Whether this buyer's recent failures amount to a decline burst.
     * @param {number} recentFailureCount
     * @returns {boolean}
     */
    static isFailureBurst(recentFailureCount)
    {
        return recentFailureCount >= PaymentAttemptQueryEngine.FAILURE_BURST_THRESHOLD;
    }
}

module.exports = PaymentAttemptQueryEngine;
