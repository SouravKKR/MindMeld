const crypto = require("crypto");
const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");

/**
 * LogArchiveQueryEngine — the manifest for cold log archives. Each row records one
 * cloud-storage object written by LogArchivalScheduler and the time range it
 * covers, so a download spanning archived data can find and read the overlapping
 * objects. The bucket object is the durable record; this manifest is the index.
 */
class LogArchiveQueryEngine
{
    static #COLLECTION_NAME = DatabaseConstants.LOG_ARCHIVES_COLLECTION;

    static async #getCollection()
    {
        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            return null;
        }
        return database.collection(LogArchiveQueryEngine.#COLLECTION_NAME);
    }

    static async insertManifest({ storagePath, coveredFrom, coveredTo, entryCount })
    {
        const collection = await LogArchiveQueryEngine.#getCollection();
        if (!collection)
        {
            throw new Error("logArchives collection unavailable");
        }

        const row =
        {
            id: crypto.randomUUID(),
            storagePath: storagePath,
            coveredFrom: coveredFrom,
            coveredTo: coveredTo,
            entryCount: Number(entryCount) || 0,
            createdAt: new Date()
        };
        await collection.insertOne({ ...row });
        return row;
    }

    /**
     * Every archive whose [coveredFrom, coveredTo] range intersects the requested
     * [fromDate, toDate] window, oldest-first.
     */
    static async findOverlapping(fromDate, toDate)
    {
        const collection = await LogArchiveQueryEngine.#getCollection();
        if (!collection)
        {
            return [];
        }

        const filter = {};
        if (toDate instanceof Date && !Number.isNaN(toDate.getTime()))
        {
            filter.coveredFrom = { $lte: toDate };
        }
        if (fromDate instanceof Date && !Number.isNaN(fromDate.getTime()))
        {
            filter.coveredTo = { $gte: fromDate };
        }

        return await collection
            .find(filter, { projection: { _id: 0 } })
            .sort({ coveredFrom: 1 })
            .toArray();
    }
}

module.exports = LogArchiveQueryEngine;
