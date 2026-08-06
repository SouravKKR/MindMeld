const crypto = require("crypto");
const DatabaseConnector = require("./DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const TimeToLiveIndexReconciler = require("./TimeToLiveIndexReconciler");

/**
 * WebhookEventQueryEngine
 *
 * Durable record of every payment-provider webhook delivery this server has
 * accepted, and the first line of replay defence.
 *
 * Providers redeliver. Razorpay retries a failed event with exponential
 * backoff for 24 hours and can replay events on request, so the same delivery
 * arriving several times is the normal operating condition rather than an
 * anomaly. Settlement is already idempotent further down (the credit ledger's
 * unique referenceKey, the pending order's PENDING -> CONSUMED transition, the
 * paid-deck grant claim), so a duplicate never double-grants — but until now
 * nothing RECORDED that a duplicate had arrived, which left no way to tell a
 * benign retry from a replay attack, and no payload to inspect when a customer
 * disputes a charge months later.
 *
 * Two jobs, in this order:
 *
 *   1. Idempotency gate. A unique index on (provider, eventId) means the
 *      second insert for the same delivery fails, and `claim` reports it as
 *      already-seen so the caller can short-circuit before doing any work.
 *      This is a cheap gate in FRONT of the settlement guards, not a
 *      replacement for them — a provider that omits an event id still settles
 *      correctly, it simply loses this early exit.
 *
 *   2. Evidence. The raw body is stored verbatim, exactly as it was signed, so
 *      a dispute or an incident has the original bytes to reason about rather
 *      than a re-serialised approximation.
 *
 * A TTL index prunes rows after the retention window; that window is long
 * because its purpose is dispute evidence, not deduplication (a provider stops
 * retrying within a day).
 */
class WebhookEventQueryEngine
{
    static #COLLECTION_NAME = DatabaseConstants.WEBHOOK_EVENTS_COLLECTION;
    static #RETENTION_DAYS = DatabaseConstants.WEBHOOK_EVENT_RETENTION_DAYS;

    // Bodies are stored for evidence, not archival. A payment webhook is a few
    // kilobytes; anything past this is truncated so a hostile or malformed
    // delivery cannot bloat the collection.
    static MAXIMUM_STORED_BODY_CHARACTERS = 64 * 1024;

    static STATUS_RECEIVED = "RECEIVED";
    static STATUS_PROCESSED = "PROCESSED";

    static #indexesEnsured = false;

    static async #getCollection()
    {
        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            return null;
        }

        const collection = database.collection(WebhookEventQueryEngine.#COLLECTION_NAME);

        if (!WebhookEventQueryEngine.#indexesEnsured)
        {
            try
            {
                // Partial, so deliveries that carry no event id (a provider that
                // omits the header) do not all collide on a single null key.
                await collection.createIndex
                (
                    { provider: 1, eventId: 1 },
                    {
                        unique: true,
                        partialFilterExpression: { eventId: { $type: "string" } }
                    }
                );
                // Through the reconciler, not createIndex directly: changing the
                // retention on a collection whose TTL index already exists is an
                // IndexOptionsConflict, which the catch below would swallow —
                // leaving the OLD expiry silently in force. That matters most
                // here, where the retention exists to hold dispute evidence.
                await TimeToLiveIndexReconciler.ensure
                (
                    database,
                    DatabaseConstants.WEBHOOK_EVENTS_COLLECTION,
                    { receivedAt: 1 },
                    WebhookEventQueryEngine.#RETENTION_DAYS * 24 * 60 * 60
                );
                WebhookEventQueryEngine.#indexesEnsured = true;
            }
            catch (indexError)
            {
                console.error("[WebhookEventQueryEngine] Failed to ensure indexes:", indexError);
            }
        }

        return collection;
    }

    static #isDuplicateKeyError(error)
    {
        return Boolean(error) && (error.code === 11000 || error.code === 11001);
    }

    /**
     * Records a verified delivery and reports whether this server has seen it
     * before.
     *
     * Fails OPEN by design. If the database is unavailable, or the provider
     * sent no event id, this returns { firstDelivery: true, recorded: false }
     * so the caller still settles the payment. Losing the audit row is a
     * diagnostic problem; refusing to settle a genuine payment because the
     * audit row could not be written would be a customer-facing one, and the
     * downstream idempotency guards make the duplicate case safe regardless.
     *
     * @param {{provider: number|string, eventId: string, eventType: string, rawBody: string, usedPreviousSecret?: boolean}} delivery
     * @returns {Promise<{firstDelivery: boolean, recorded: boolean}>}
     */
    static async claim({ provider, eventId, eventType, rawBody, usedPreviousSecret } = {})
    {
        const collection = await WebhookEventQueryEngine.#getCollection();
        if (!collection)
        {
            return { firstDelivery: true, recorded: false };
        }

        const normalizedEventId = (typeof eventId === "string" && eventId.length > 0) ? eventId : null;
        const normalizedBody = typeof rawBody === "string"
            ? rawBody.slice(0, WebhookEventQueryEngine.MAXIMUM_STORED_BODY_CHARACTERS)
            : "";

        const row =
        {
            id: crypto.randomUUID(),
            provider: provider !== undefined ? provider : null,
            eventId: normalizedEventId,
            eventType: typeof eventType === "string" ? eventType : "",
            signatureValid: true,
            // True only while a webhook-secret rotation window is open and this
            // delivery was still signed with the outgoing secret — the signal
            // that the previous secret cannot be retired yet.
            usedPreviousSecret: usedPreviousSecret === true,
            rawBody: normalizedBody,
            bodyTruncated: typeof rawBody === "string" && rawBody.length > WebhookEventQueryEngine.MAXIMUM_STORED_BODY_CHARACTERS,
            status: WebhookEventQueryEngine.STATUS_RECEIVED,
            receivedAt: new Date(),
            processedAt: new Date(0)
        };

        try
        {
            await collection.insertOne(row);
            return { firstDelivery: true, recorded: true };
        }
        catch (insertError)
        {
            if (WebhookEventQueryEngine.#isDuplicateKeyError(insertError))
            {
                return { firstDelivery: false, recorded: true };
            }

            console.error("[WebhookEventQueryEngine] Failed to record webhook delivery:", insertError);
            return { firstDelivery: true, recorded: false };
        }
    }

    /**
     * Marks a recorded delivery as fully processed. Best-effort: a failure here
     * must never fail the webhook response.
     */
    static async markProcessed(provider, eventId, outcome = "")
    {
        if (typeof eventId !== "string" || eventId.length === 0)
        {
            return;
        }

        const collection = await WebhookEventQueryEngine.#getCollection();
        if (!collection)
        {
            return;
        }

        try
        {
            await collection.updateOne
            (
                { provider: provider, eventId: eventId },
                {
                    $set:
                    {
                        status: WebhookEventQueryEngine.STATUS_PROCESSED,
                        outcome: typeof outcome === "string" ? outcome : "",
                        processedAt: new Date()
                    }
                }
            );
        }
        catch (updateError)
        {
            console.error("[WebhookEventQueryEngine] Failed to mark webhook delivery processed:", updateError);
        }
    }
}

module.exports = WebhookEventQueryEngine;
