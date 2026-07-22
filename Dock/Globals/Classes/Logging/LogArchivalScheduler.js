const crypto = require("crypto");
const LogConfigurationStore = require("./LogConfigurationStore");
const LogEventQueryEngine = require("./LogEventQueryEngine");
const LogArchiveQueryEngine = require("./LogArchiveQueryEngine");
const Persistence = require("../Persistence");
const { storageTargets } = require("../../Enumerations/StorageTargets");
const DatabaseConstants = require("../../Constants/DatabaseConstants");

/**
 * LogArchivalScheduler — moves log entries older than the settable interval out of
 * the hot logEvents collection and into cloud storage, then records a manifest row
 * so downloads can still reach the archived data. Mirrors the KeyRotationScheduler
 * pattern (interval loop, single-runner).
 *
 * The ordering is strictly WRITE → VERIFY → DELETE, per batch: the cloud-storage
 * object is written and its existence confirmed BEFORE the corresponding entries
 * are deleted from MongoDB. A crash mid-run therefore leaves already-archived rows
 * un-deleted (they are re-archived next run — a harmless overlap) but never loses
 * an entry. A distributed lock keeps two runners from archiving at once.
 */
class LogArchivalScheduler
{
    static #TICK_INTERVAL_MILLISECONDS = 60 * 60 * 1000;
    static #INITIAL_DELAY_MILLISECONDS = 60 * 1000;
    static #LOCK_DURATION_MILLISECONDS = 10 * 60 * 1000;
    static #ARCHIVE_BATCH_SIZE = 1000;

    static #intervalHandle = null;
    static #bRunning = false;

    static start()
    {
        if (LogArchivalScheduler.#intervalHandle !== null)
        {
            return;
        }

        LogArchivalScheduler.#intervalHandle = setInterval(() => { LogArchivalScheduler.#tick(); }, LogArchivalScheduler.#TICK_INTERVAL_MILLISECONDS);
        if (typeof LogArchivalScheduler.#intervalHandle.unref === "function")
        {
            LogArchivalScheduler.#intervalHandle.unref();
        }

        // One deferred check shortly after boot (let the database settle first).
        const initialTimer = setTimeout(() => { LogArchivalScheduler.#tick(); }, LogArchivalScheduler.#INITIAL_DELAY_MILLISECONDS);
        if (typeof initialTimer.unref === "function")
        {
            initialTimer.unref();
        }
    }

    static async #tick()
    {
        try
        {
            const configuration = await LogConfigurationStore.load();
            const lastArchivedAt = configuration.lastArchivedAt ? new Date(configuration.lastArchivedAt) : null;
            const intervalMilliseconds = configuration.archivalIntervalDays * 24 * 60 * 60 * 1000;
            const elapsedMilliseconds = lastArchivedAt ? (Date.now() - lastArchivedAt.getTime()) : Infinity;

            if (elapsedMilliseconds >= intervalMilliseconds)
            {
                await LogArchivalScheduler.runNow();
            }
        }
        catch (tickError)
        {
            console.error("[LogArchivalScheduler] tick failed:", tickError?.message || tickError);
        }
    }

    static async runNow()
    {
        if (LogArchivalScheduler.#bRunning)
        {
            return;
        }
        LogArchivalScheduler.#bRunning = true;

        const lockToken = crypto.randomUUID();
        let lockAcquired = false;
        try
        {
            // Ensure the configuration document exists so the lock can be set on it.
            await LogConfigurationStore.load();
            lockAcquired = await LogConfigurationStore.acquireLock(lockToken, LogArchivalScheduler.#LOCK_DURATION_MILLISECONDS);
            if (!lockAcquired)
            {
                return;
            }

            await LogArchivalScheduler.#archive();
            await LogConfigurationStore.recordArchivalRun(new Date());
        }
        catch (runError)
        {
            console.error("[LogArchivalScheduler] archival run failed:", runError?.message || runError);
        }
        finally
        {
            if (lockAcquired)
            {
                try { await LogConfigurationStore.releaseLock(lockToken); } catch (releaseError) { }
            }
            LogArchivalScheduler.#bRunning = false;
        }
    }

    static async #archive()
    {
        const cutoffDate = new Date();
        const cursor = await LogEventQueryEngine.findForArchival(cutoffDate, LogArchivalScheduler.#ARCHIVE_BATCH_SIZE);
        if (!cursor)
        {
            return;
        }

        let batch = [];
        let batchIndex = 0;

        const flushBatch = async () =>
        {
            if (batch.length === 0)
            {
                return;
            }
            const currentBatch = batch;
            batch = [];
            batchIndex++;
            await LogArchivalScheduler.#writeAndDeleteBatch(currentBatch, cutoffDate, batchIndex);
        };

        for await (const entry of cursor)
        {
            batch.push(entry);
            if (batch.length >= LogArchivalScheduler.#ARCHIVE_BATCH_SIZE)
            {
                await flushBatch();
            }
        }
        await flushBatch();
    }

    static async #writeAndDeleteBatch(entries, cutoffDate, batchIndex)
    {
        const lines = [];
        const ids = [];
        let coveredFrom = null;
        let coveredTo = null;

        for (const entry of entries)
        {
            const timestamp = entry.timestamp instanceof Date ? entry.timestamp : new Date(entry.timestamp);
            if (coveredFrom === null || timestamp < coveredFrom)
            {
                coveredFrom = timestamp;
            }
            if (coveredTo === null || timestamp > coveredTo)
            {
                coveredTo = timestamp;
            }
            ids.push(entry.id);
            lines.push(JSON.stringify({ ...entry, timestamp: timestamp.toISOString() }));
        }

        const storagePath = `${DatabaseConstants.LOG_ARCHIVE_STORAGE_PREFIX}/${LogArchivalScheduler.#environmentSegment()}/archive_${cutoffDate.toISOString().replace(/[:.]/g, "-")}_${batchIndex}_${crypto.randomUUID()}.ndjson`;

        // WRITE → VERIFY → DELETE. Never delete before a verified write.
        await Persistence.write(storagePath, `${lines.join("\n")}\n`, storageTargets.LINODE_OBJECT_STORAGE);

        const exists = await Persistence.exists(storagePath, storageTargets.LINODE_OBJECT_STORAGE);
        if (!exists)
        {
            throw new Error(`archive object ${storagePath} not found after write; aborting delete to avoid data loss`);
        }

        await LogArchiveQueryEngine.insertManifest({ storagePath, coveredFrom, coveredTo, entryCount: entries.length });
        await LogEventQueryEngine.deleteByIds(ids);
    }

    static #environmentSegment()
    {
        const environment = process.env.COGNIUMLEARN_ENVIRONMENT || (process.argv.includes("--debug") ? "local" : "production");
        return String(environment).replace(/[^A-Za-z0-9_-]/g, "_");
    }
}

module.exports = LogArchivalScheduler;
