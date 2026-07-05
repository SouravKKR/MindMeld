const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");

/**
 * LogTailQueryEngine — powers the live-tail stream. It returns entries newer than
 * a cursor timestamp, applying the same level / category / search filters as the
 * admin panel so only matching entries are pushed. Sourcing the live view from
 * MongoDB (rather than Dock's in-process ingester) is deliberate: Agent and
 * burst-virtual-machine workers write straight to logEvents, so this is the only
 * way the live view shows entries from every service.
 */
class LogTailQueryEngine
{
    static #COLLECTION_NAME = DatabaseConstants.LOG_EVENTS_COLLECTION;
    static #MAXIMUM_TAIL_LIMIT = 500;

    static async #getCollection()
    {
        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            return null;
        }
        return database.collection(LogTailQueryEngine.#COLLECTION_NAME);
    }

    static #escapeRegex(rawString)
    {
        return String(rawString).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    static async fetchSince(sinceDate, { levels = null, categories = null, search = null } = {}, limit = 200)
    {
        const collection = await LogTailQueryEngine.#getCollection();
        if (!collection)
        {
            return [];
        }

        const filter = {};
        if (sinceDate instanceof Date && !Number.isNaN(sinceDate.getTime()))
        {
            filter.timestamp = { $gt: sinceDate };
        }
        if (Array.isArray(levels) && levels.length > 0)
        {
            filter.level = { $in: levels.map(Number) };
        }
        if (Array.isArray(categories) && categories.length > 0)
        {
            filter.category = { $in: categories.map(Number) };
        }
        if (typeof search === "string" && search.trim().length > 0)
        {
            const escaped = LogTailQueryEngine.#escapeRegex(search.trim());
            filter.$or =
            [
                { title: { $regex: escaped, $options: "i" } },
                { message: { $regex: escaped, $options: "i" } },
                { accountId: { $regex: escaped, $options: "i" } }
            ];
        }

        const effectiveLimit = Math.min(Math.max(Number(limit) || 1, 1), LogTailQueryEngine.#MAXIMUM_TAIL_LIMIT);

        return await collection
            .find(filter, { projection: { _id: 0 } })
            .sort({ timestamp: 1, sequence: 1 })
            .limit(effectiveLimit)
            .toArray();
    }
}

module.exports = LogTailQueryEngine;
