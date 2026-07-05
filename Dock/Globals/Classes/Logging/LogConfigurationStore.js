const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");

/**
 * LogConfigurationStore — the singleton logConfiguration document
 * (logConfiguration._id == "global") holding the admin-settable archival interval
 * and the last-archived timestamp, plus a lightweight distributed lock used by the
 * archival scheduler so only one runner archives at a time. Mirrors the
 * CreditConfigurationStore pattern (short in-process cache + upsert-on-first-read).
 */
class LogConfigurationStore
{
    static #DOCUMENT_ID = "global";
    static #DEFAULT_ARCHIVAL_INTERVAL_DAYS = DatabaseConstants.LOG_DEFAULT_ARCHIVAL_INTERVAL_DAYS;
    static #CACHE_TTL_MILLISECONDS = 15 * 1000;

    static #cachedConfiguration = null;
    static #cachedAtMilliseconds = 0;

    static async #getCollection()
    {
        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            return null;
        }
        return database.collection(DatabaseConstants.LOG_CONFIGURATION_COLLECTION);
    }

    static #withDefaults(document)
    {
        const intervalDays = Number(document && document.archivalIntervalDays);
        return {
            archivalIntervalDays: (Number.isFinite(intervalDays) && intervalDays >= 1) ? Math.floor(intervalDays) : LogConfigurationStore.#DEFAULT_ARCHIVAL_INTERVAL_DAYS,
            lastArchivedAt: (document && document.lastArchivedAt) || null,
            updatedAt: (document && document.updatedAt) || null,
            updatedBy: (document && document.updatedBy) || ""
        };
    }

    static async load()
    {
        const now = Date.now();
        if (LogConfigurationStore.#cachedConfiguration !== null && (now - LogConfigurationStore.#cachedAtMilliseconds) < LogConfigurationStore.#CACHE_TTL_MILLISECONDS)
        {
            return LogConfigurationStore.#cachedConfiguration;
        }

        const collection = await LogConfigurationStore.#getCollection();
        if (!collection)
        {
            return LogConfigurationStore.#withDefaults(null);
        }

        let document = await collection.findOne({ _id: LogConfigurationStore.#DOCUMENT_ID });
        if (!document)
        {
            const seeded = LogConfigurationStore.#withDefaults(null);
            seeded.updatedAt = new Date();
            await collection.updateOne({ _id: LogConfigurationStore.#DOCUMENT_ID }, { $set: seeded }, { upsert: true });
            document = { _id: LogConfigurationStore.#DOCUMENT_ID, ...seeded };
        }

        const configuration = LogConfigurationStore.#withDefaults(document);
        LogConfigurationStore.#cachedConfiguration = configuration;
        LogConfigurationStore.#cachedAtMilliseconds = now;
        return configuration;
    }

    /**
     * Persists a new archival interval and returns both the previous interval and
     * the new configuration, so the caller can decide whether a shortened interval
     * has already elapsed and should trigger an immediate archival run.
     */
    static async saveIntervalDays(archivalIntervalDays, updatedByUserId)
    {
        const collection = await LogConfigurationStore.#getCollection();
        if (!collection)
        {
            throw new Error("logConfiguration collection unavailable");
        }

        const previous = await LogConfigurationStore.load();
        const normalized = Math.max(1, Math.floor(Number(archivalIntervalDays) || LogConfigurationStore.#DEFAULT_ARCHIVAL_INTERVAL_DAYS));

        await collection.updateOne
        (
            { _id: LogConfigurationStore.#DOCUMENT_ID },
            { $set: { archivalIntervalDays: normalized, updatedAt: new Date(), updatedBy: updatedByUserId || "" } },
            { upsert: true }
        );

        LogConfigurationStore.invalidateCache();
        const configuration = await LogConfigurationStore.load();
        return { previousIntervalDays: previous.archivalIntervalDays, configuration: configuration };
    }

    static async recordArchivalRun(runDate)
    {
        const collection = await LogConfigurationStore.#getCollection();
        if (!collection)
        {
            return;
        }
        await collection.updateOne({ _id: LogConfigurationStore.#DOCUMENT_ID }, { $set: { lastArchivedAt: runDate } }, { upsert: true });
        LogConfigurationStore.invalidateCache();
    }

    /**
     * Atomic single-runner lock. Succeeds only if no unexpired lock is held.
     * Serialised writes on the single document make the modifiedCount check a
     * correct compare-and-set: a concurrent acquirer sees the just-written token
     * and its filter no longer matches.
     */
    static async acquireLock(lockToken, lockDurationMilliseconds)
    {
        const collection = await LogConfigurationStore.#getCollection();
        if (!collection)
        {
            return false;
        }

        const now = new Date();
        const lockExpiresAt = new Date(now.getTime() + lockDurationMilliseconds);
        const result = await collection.updateOne
        (
            {
                _id: LogConfigurationStore.#DOCUMENT_ID,
                $or:
                [
                    { lockToken: { $in: [null, ""] } },
                    { lockToken: { $exists: false } },
                    { lockExpiresAt: { $lt: now } }
                ]
            },
            { $set: { lockToken: lockToken, lockExpiresAt: lockExpiresAt } }
        );
        return result.modifiedCount === 1;
    }

    static async releaseLock(lockToken)
    {
        const collection = await LogConfigurationStore.#getCollection();
        if (!collection)
        {
            return;
        }
        await collection.updateOne({ _id: LogConfigurationStore.#DOCUMENT_ID, lockToken: lockToken }, { $set: { lockToken: null, lockExpiresAt: null } });
    }

    static invalidateCache()
    {
        LogConfigurationStore.#cachedConfiguration = null;
        LogConfigurationStore.#cachedAtMilliseconds = 0;
    }
}

module.exports = LogConfigurationStore;
