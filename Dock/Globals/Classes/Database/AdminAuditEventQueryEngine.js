const crypto = require("crypto");
const DatabaseConnector = require("./DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");

/**
 * AdminAuditEventQueryEngine
 *
 * Durable, admin-visible audit trail of privileged actions. Every request that
 * reaches an admin-gated endpoint (via EnsureAdmin or EnsureOrgAdmin) is recorded
 * here with the acting administrator, the endpoint and method invoked, the final
 * HTTP status (so success vs. a blocked 401/403 or a server error is visible),
 * and the source IP. This answers "who did what privileged action, when, and did
 * it succeed?" — the persistent trail that previously did not exist.
 *
 * Deliberately records the action coordinates (actor, endpoint, method, status)
 * but NOT the request body: admin bodies can carry secrets (paid-deck content,
 * rotated keys, payment payloads), and an audit log must never become a second
 * place those secrets live. The endpoint path already names the action.
 *
 * record() is intentionally non-throwing — auditing must never break or slow the
 * action it observes — so all errors are swallowed and callers fire-and-forget.
 * A TTL index on occurredAt (see DatabaseConnector) prunes old rows, matching the
 * retention convention used by rateLimitEvents.
 *
 * occurredAt is a BSON Date so the Mongo TTL index can expire rows (TTL ignores
 * string fields); it serializes back to an ISO string in JSON responses.
 */
class AdminAuditEventQueryEngine
{
    static #COLLECTION_NAME = DatabaseConstants.ADMIN_AUDIT_EVENTS_COLLECTION;
    static #LIST_LIMIT = 500;

    static async #getCollection()
    {
        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            return null;
        }
        return database.collection(AdminAuditEventQueryEngine.#COLLECTION_NAME);
    }

    /**
     * Records a single admin-action event. Never throws. Returns the stored row,
     * or null if the database was unavailable or the write failed.
     */
    static async record({ actorUserId = null, actorEmail = null, actorRole = null, endpoint, method, statusCode, ipAddress = null } = {})
    {
        try
        {
            const collection = await AdminAuditEventQueryEngine.#getCollection();
            if (!collection)
            {
                return null;
            }

            const numericStatus = Number(statusCode);
            const row =
            {
                id: crypto.randomUUID(),
                actorUserId: actorUserId || null,
                actorEmail: actorEmail || null,
                actorRole: actorRole !== null && actorRole !== undefined ? Number(actorRole) : null,
                endpoint: typeof endpoint === "string" ? endpoint : "",
                method: typeof method === "string" ? method : "",
                statusCode: Number.isFinite(numericStatus) ? numericStatus : null,
                outcome: Number.isFinite(numericStatus) && numericStatus >= 200 && numericStatus < 400 ? "SUCCESS" : "FAILURE",
                ipAddress: ipAddress || null,
                occurredAt: new Date()
            };

            await collection.insertOne({ ...row });
            return row;
        }
        catch (recordError)
        {
            console.error("[AdminAuditEventQueryEngine] Failed to record admin audit event:", recordError);
            return null;
        }
    }

    /**
     * Lists admin audit events newest-first. `since` (ISO string) restricts to
     * events strictly newer; `outcome` restricts to "SUCCESS" | "FAILURE".
     */
    static async list({ since = null, outcome = null, limit = AdminAuditEventQueryEngine.#LIST_LIMIT } = {})
    {
        const collection = await AdminAuditEventQueryEngine.#getCollection();
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
        if (typeof outcome === "string" && outcome.length > 0)
        {
            filter.outcome = outcome;
        }

        const effectiveLimit = Math.min(Math.max(Number(limit) || AdminAuditEventQueryEngine.#LIST_LIMIT, 1), AdminAuditEventQueryEngine.#LIST_LIMIT);

        return await collection
            .find(filter, { projection: { _id: 0 } })
            .sort({ occurredAt: -1 })
            .limit(effectiveLimit)
            .toArray();
    }

    /**
     * Counts events whose occurredAt is at or after the given ISO timestamp.
     * Used for the admin summary ("N admin actions in the last 24h").
     */
    static async countSince(sinceIso)
    {
        const collection = await AdminAuditEventQueryEngine.#getCollection();
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

module.exports = AdminAuditEventQueryEngine;
