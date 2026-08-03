const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");

/**
 * LogEventQueryEngine — data access for the central logEvents collection: batch
 * insertion (used by LogIngester), time-range reads (download + live tail via the
 * tail engine), a streaming cursor for archival, and delete-by-id (archival, only
 * after a verified cloud-storage write).
 *
 * insertMany DELIBERATELY throws on failure so LogIngester can keep its
 * write-ahead-log and retry — the "no logs lost" guarantee depends on a failed
 * insert never being silently dropped. A duplicate-key error is treated as
 * success (the entries are already stored — a harmless re-drain after a crash).
 */
class LogEventQueryEngine
{
    static #COLLECTION_NAME = DatabaseConstants.LOG_EVENTS_COLLECTION;
    static #MAXIMUM_QUERY_LIMIT = 500000;

    static async #getCollection()
    {
        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            return null;
        }
        return database.collection(LogEventQueryEngine.#COLLECTION_NAME);
    }

    /**
     * Batch-inserts already-built log documents. Throws if the database is
     * unavailable or the write fails so the caller retries rather than losing
     * entries. `ordered: false` lets a duplicate id skip without aborting the
     * whole batch (idempotent re-drain after a crash).
     */
    static async insertMany(logEntryDocuments)
    {
        if (!Array.isArray(logEntryDocuments) || logEntryDocuments.length === 0)
        {
            return 0;
        }

        const collection = await LogEventQueryEngine.#getCollection();
        if (!collection)
        {
            throw new Error("logEvents collection unavailable");
        }

        try
        {
            const result = await collection.insertMany(logEntryDocuments, { ordered: false });
            return result.insertedCount;
        }
        catch (insertError)
        {
            if (insertError && insertError.code === 11000)
            {
                return 0;
            }
            throw insertError;
        }
    }

    static #buildRangeFilter({ fromDate = null, toDate = null, levels = null, categories = null, accountIds = null })
    {
        const filter = {};
        const timestampFilter = {};

        if (fromDate instanceof Date && !Number.isNaN(fromDate.getTime()))
        {
            timestampFilter.$gte = fromDate;
        }
        if (toDate instanceof Date && !Number.isNaN(toDate.getTime()))
        {
            timestampFilter.$lte = toDate;
        }
        if (Object.keys(timestampFilter).length > 0)
        {
            filter.timestamp = timestampFilter;
        }
        if (Array.isArray(levels) && levels.length > 0)
        {
            filter.level = { $in: levels.map(level => Number(level)) };
        }
        if (Array.isArray(categories) && categories.length > 0)
        {
            filter.category = { $in: categories.map(category => Number(category)) };
        }

        // Restricts the export to specific accounts. The support-ticket log export
        // passes the reporter's id plus the empty string, which is what unattributed
        // system and server entries carry — that combination yields the errors
        // around a reported problem without exposing any other identifiable user's
        // activity. Omitted entirely by the unrestricted admin download.
        if (Array.isArray(accountIds) && accountIds.length > 0)
        {
            filter.accountId = { $in: accountIds.map(accountId => String(accountId ?? "")) };
        }

        return filter;
    }

    /**
     * Reads hot entries in a time range, oldest-first (stable by sequence), for the
     * download endpoint. Bounded by an absolute cap so a huge range cannot exhaust
     * memory — the caller streams cold archives for anything older than the window.
     */
    static async queryRange({ fromDate = null, toDate = null, levels = null, categories = null, accountIds = null, limit = LogEventQueryEngine.#MAXIMUM_QUERY_LIMIT })
    {
        const collection = await LogEventQueryEngine.#getCollection();
        if (!collection)
        {
            return [];
        }

        const filter = LogEventQueryEngine.#buildRangeFilter({ fromDate, toDate, levels, categories, accountIds });
        const effectiveLimit = Math.min(Math.max(Number(limit) || 0, 1), LogEventQueryEngine.#MAXIMUM_QUERY_LIMIT);

        return await collection
            .find(filter, { projection: { _id: 0 } })
            .sort({ timestamp: 1, sequence: 1 })
            .limit(effectiveLimit)
            .toArray();
    }

    /**
     * A streaming cursor over entries at or before the cutoff, oldest-first, so the
     * archival scheduler can process them in batches without loading everything.
     */
    static async findForArchival(cutoffDate, batchSize = 1000)
    {
        const collection = await LogEventQueryEngine.#getCollection();
        if (!collection)
        {
            return null;
        }

        return collection
            .find({ timestamp: { $lte: cutoffDate } }, { projection: { _id: 0 } })
            .sort({ timestamp: 1, sequence: 1 })
            .batchSize(batchSize);
    }

    /**
     * Deletes entries by id. Used only by the archival scheduler AFTER the batch
     * has been written to cloud storage and verified — never before.
     */
    static async deleteByIds(ids)
    {
        if (!Array.isArray(ids) || ids.length === 0)
        {
            return 0;
        }

        const collection = await LogEventQueryEngine.#getCollection();
        if (!collection)
        {
            throw new Error("logEvents collection unavailable");
        }

        const result = await collection.deleteMany({ id: { $in: ids } });
        return result.deletedCount;
    }
}

module.exports = LogEventQueryEngine;
