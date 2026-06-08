const crypto = require("crypto");
const DatabaseConnector = require("./DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const { alertSeverity } = require("../../Enumerations/AlertSeverity");

/**
 * AlertQueryEngine
 *
 * Durable, admin-visible operational alert log. Subsystems (e.g. the ECB
 * rates client) record problems here through the non-throwing [Alerts.js]
 * helper so a failure is recorded without breaking the request that hit it.
 *
 * Dedupe: an unacknowledged row is keyed by (source, title). Re-raising the
 * same (source, title) bumps occurrenceCount + lastSeenAt and refreshes the
 * latest message/severity/metadata instead of inserting a duplicate — so a
 * flapping dependency produces one growing row, not thousands. Acknowledging
 * a row "closes" it; the next occurrence opens a fresh row.
 *
 * Dates are stored as ISO strings to match the codegen serialization
 * convention used across the rest of the collections.
 */
class AlertQueryEngine
{
    static #COLLECTION_NAME = DatabaseConstants.ALERTS_COLLECTION;
    static #LIST_LIMIT = 500;

    static async #getCollection()
    {
        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            return null;
        }
        return database.collection(AlertQueryEngine.#COLLECTION_NAME);
    }

    static #normalizeSeverity(severity)
    {
        const numeric = Number(severity);
        const allowed = Object.values(alertSeverity);
        return allowed.includes(numeric) ? numeric : alertSeverity.WARNING;
    }

    /**
     * Records an alert, deduplicating against the open (unacknowledged) row
     * with the same source + title. Returns the stored row, or null if the
     * database was unavailable.
     */
    static async raise({ severity, source, title, message = "", metadata = {} } = {})
    {
        const collection = await AlertQueryEngine.#getCollection();
        if (!collection)
        {
            return null;
        }

        const normalizedSource = typeof source === "string" && source.trim().length > 0 ? source.trim() : "GENERAL";
        const normalizedTitle = typeof title === "string" && title.trim().length > 0 ? title.trim() : "Unspecified alert";
        const normalizedMessage = typeof message === "string" ? message : "";
        const normalizedSeverity = AlertQueryEngine.#normalizeSeverity(severity);
        const nowIso = new Date().toISOString();

        const existing = await collection.findOne
        ({
            source: normalizedSource,
            title: normalizedTitle,
            acknowledged: false
        });

        if (existing)
        {
            await collection.updateOne
            (
                { id: existing.id },
                {
                    $set:
                    {
                        severity: normalizedSeverity,
                        message: normalizedMessage,
                        metadata: metadata && typeof metadata === "object" ? metadata : {},
                        lastSeenAt: nowIso
                    },
                    $inc: { occurrenceCount: 1 }
                }
            );
            return await collection.findOne({ id: existing.id }, { projection: { _id: 0 } });
        }

        const row =
        {
            id: crypto.randomUUID(),
            severity: normalizedSeverity,
            source: normalizedSource,
            title: normalizedTitle,
            message: normalizedMessage,
            metadata: metadata && typeof metadata === "object" ? metadata : {},
            acknowledged: false,
            occurrenceCount: 1,
            createdAt: nowIso,
            lastSeenAt: nowIso
        };

        await collection.insertOne({ ...row });
        return row;
    }

    /**
     * Lists alerts newest-activity first. `onlyUnacknowledged` hides closed
     * rows; `since` (ISO string) restricts to rows whose lastSeenAt is
     * strictly newer — used by the admin notifier's poll loop.
     */
    static async list({ onlyUnacknowledged = false, since = null, limit = AlertQueryEngine.#LIST_LIMIT } = {})
    {
        const collection = await AlertQueryEngine.#getCollection();
        if (!collection)
        {
            return [];
        }

        const filter = {};
        if (onlyUnacknowledged)
        {
            filter.acknowledged = false;
        }
        if (typeof since === "string" && since.length > 0)
        {
            filter.lastSeenAt = { $gt: since };
        }

        const effectiveLimit = Math.min(Math.max(Number(limit) || AlertQueryEngine.#LIST_LIMIT, 1), AlertQueryEngine.#LIST_LIMIT);

        return await collection
            .find(filter, { projection: { _id: 0 } })
            .sort({ lastSeenAt: -1 })
            .limit(effectiveLimit)
            .toArray();
    }

    static async acknowledge(alertId)
    {
        if (typeof alertId !== "string" || alertId.length === 0)
        {
            return { ok: false, reason: "INVALID_ID" };
        }
        const collection = await AlertQueryEngine.#getCollection();
        if (!collection)
        {
            return { ok: false, reason: "DATABASE_UNAVAILABLE" };
        }

        const result = await collection.updateOne
        (
            { id: alertId },
            { $set: { acknowledged: true, acknowledgedAt: new Date().toISOString() } }
        );
        if (result.matchedCount === 0)
        {
            return { ok: false, reason: "NOT_FOUND" };
        }
        return { ok: true };
    }

    static async deleteById(alertId)
    {
        if (typeof alertId !== "string" || alertId.length === 0)
        {
            return { removed: false, reason: "INVALID_ID" };
        }
        const collection = await AlertQueryEngine.#getCollection();
        if (!collection)
        {
            return { removed: false, reason: "DATABASE_UNAVAILABLE" };
        }

        const result = await collection.deleteOne({ id: alertId });
        if (result.deletedCount === 0)
        {
            return { removed: false, reason: "NOT_FOUND" };
        }
        return { removed: true };
    }
}

module.exports = AlertQueryEngine;
