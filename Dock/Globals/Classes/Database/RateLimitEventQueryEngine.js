const crypto = require("crypto");
const DatabaseConnector = require("./DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const {httpStatus} = require("../../Enumerations/HttpStatus");

/**
 * RateLimitEventQueryEngine
 *
 * Durable, admin-visible log of server-side 429 (Too Many Requests) responses.
 * Every 429 — whether from Packetron's built-in per-endpoint "overall" cap, the
 * custom per-user plugin, or a feature-specific cooldown/quota — is recorded
 * here so admins can review abuse and tune limits from the admin panel.
 *
 * record() is intentionally non-throwing: logging a rejection must never break
 * or slow the request that hit the limit, so all errors are swallowed and the
 * caller can fire-and-forget. A TTL index on occurredAt (see DatabaseConnector)
 * prunes old rows, matching the retention convention used by screenshotEvents.
 *
 * occurredAt is stored as a BSON Date so the Mongo TTL index can expire rows
 * (TTL ignores string fields). It serializes back to an ISO string in JSON
 * responses, so the admin client receives a plain timestamp string.
 */
class RateLimitEventQueryEngine
{
    static #COLLECTION_NAME = DatabaseConstants.RATE_LIMIT_EVENTS_COLLECTION;
    static #LIST_LIMIT = 500;

    static async #getCollection()
    {
        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            return null;
        }
        return database.collection(RateLimitEventQueryEngine.#COLLECTION_NAME);
    }

    /**
     * Records a single 429 event. Never throws. Returns the stored row, or null
     * if the database was unavailable or the write failed.
     */
    static async record({ endpoint, method, scope, identityType, identityKey, userId = null, ipAddress = null, limit = null, windowMilliseconds = null, retryAfterSeconds = null } = {})
    {
        try
        {
            const collection = await RateLimitEventQueryEngine.#getCollection();
            if (!collection)
            {
                return null;
            }

            const row =
            {
                id: crypto.randomUUID(),
                endpoint: typeof endpoint === "string" ? endpoint : "",
                method: typeof method === "string" ? method : "",
                scope: typeof scope === "string" ? scope : "OVERALL",
                identityType: typeof identityType === "string" ? identityType : "UNKNOWN",
                identityKey: typeof identityKey === "string" ? identityKey : "",
                userId: userId || null,
                ipAddress: ipAddress || null,
                limit: limit !== null && limit !== undefined ? Number(limit) : null,
                windowMilliseconds: windowMilliseconds !== null && windowMilliseconds !== undefined ? Number(windowMilliseconds) : null,
                retryAfterSeconds: retryAfterSeconds !== null && retryAfterSeconds !== undefined ? Number(retryAfterSeconds) : null,
                statusCode: httpStatus.TOO_MANY_REQUESTS,
                occurredAt: new Date()
            };

            await collection.insertOne({ ...row });
            return row;
        }
        catch (recordError)
        {
            console.error("[RateLimitEventQueryEngine] Failed to record rate-limit event:", recordError);
            return null;
        }
    }

    /**
     * Lists rate-limit events newest-first. `since` (ISO string) restricts to
     * events strictly newer; `scope` restricts to a single scope label.
     */
    static async list({ since = null, scope = null, limit = RateLimitEventQueryEngine.#LIST_LIMIT } = {})
    {
        const collection = await RateLimitEventQueryEngine.#getCollection();
        if (!collection)
        {
            return [];
        }

        const filter = {};
        if (typeof since === "string" && since.length > 0)
        {
            const sinceDate = new Date(since);
            if (!Number.isNaN(sinceDate.getTime()))
            {
                filter.occurredAt = { $gt: sinceDate };
            }
        }
        if (typeof scope === "string" && scope.length > 0)
        {
            filter.scope = scope;
        }

        const effectiveLimit = Math.min(Math.max(Number(limit) || RateLimitEventQueryEngine.#LIST_LIMIT, 1), RateLimitEventQueryEngine.#LIST_LIMIT);

        return await collection
            .find(filter, { projection: { _id: 0 } })
            .sort({ occurredAt: -1 })
            .limit(effectiveLimit)
            .toArray();
    }

    /**
     * Counts events whose occurredAt is at or after the given ISO timestamp.
     * Used for the admin summary ("N rate-limit events in the last 24h").
     */
    static async countSince(sinceIso)
    {
        const collection = await RateLimitEventQueryEngine.#getCollection();
        if (!collection || typeof sinceIso !== "string" || sinceIso.length === 0)
        {
            return 0;
        }

        const sinceDate = new Date(sinceIso);
        if (Number.isNaN(sinceDate.getTime()))
        {
            return 0;
        }

        return await collection.countDocuments({ occurredAt: { $gte: sinceDate } });
    }
}

module.exports = RateLimitEventQueryEngine;
