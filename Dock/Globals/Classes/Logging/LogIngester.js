const fs = require("fs");
const path = require("path");
const LogEventQueryEngine = require("./LogEventQueryEngine");

/**
 * LogIngester — the durability + persistence pipeline behind Logger. Every entry
 * is (1) appended to an on-disk write-ahead-log for crash safety and (2) queued in
 * memory; a background loop batch-inserts the queue into the logEvents collection.
 *
 * On a MongoDB outage the queue simply retries and the write-ahead-log keeps the
 * entries (nothing is dropped). Once a batch is safely persisted the queue drains,
 * and once fully drained the write-ahead-log is rotated (the fully-ingested file
 * is deleted and a fresh one started) so it can never grow unbounded. On boot any
 * write-ahead-log left behind by a crashed run is drained into MongoDB first
 * (duplicate ids are ignored), so no entry written before a crash is ever lost.
 */
class LogIngester
{
    static #WRITE_AHEAD_LOG_DIRECTORY = path.join(__dirname, "..", "..", "..", "..", "Agent", "logs", "writeAheadLog");
    static #FLUSH_INTERVAL_MILLISECONDS = 1000;
    static #MAXIMUM_BATCH_SIZE = 500;

    static #writeStream = null;
    static #writeAheadLogPath = null;
    static #pendingQueue = [];
    static #linesSinceRotate = 0;
    static #flushTimer = null;
    static #bFlushing = false;
    static #bStarted = false;

    static async start()
    {
        if (LogIngester.#bStarted)
        {
            return;
        }
        LogIngester.#bStarted = true;

        LogIngester.#ensureWriteStream();

        // Recover anything a previous (possibly crashed) run wrote but did not
        // confirm into MongoDB, THEN start the periodic flush.
        await LogIngester.#drainOrphanedWriteAheadLogs();

        LogIngester.#flushTimer = setInterval(() => { LogIngester.#flush(); }, LogIngester.#FLUSH_INTERVAL_MILLISECONDS);
        if (typeof LogIngester.#flushTimer.unref === "function")
        {
            LogIngester.#flushTimer.unref();
        }
    }

    static #ensureWriteStream()
    {
        if (LogIngester.#writeStream)
        {
            return;
        }

        try
        {
            fs.mkdirSync(LogIngester.#WRITE_AHEAD_LOG_DIRECTORY, { recursive: true });
            if (!LogIngester.#writeAheadLogPath)
            {
                LogIngester.#writeAheadLogPath = path.join(LogIngester.#WRITE_AHEAD_LOG_DIRECTORY, `dock_${Date.now()}_${process.pid}.ndjson`);
            }
            LogIngester.#writeStream = fs.createWriteStream(LogIngester.#writeAheadLogPath, { flags: "a", encoding: "utf-8" });
        }
        catch (streamError)
        {
            console.error("[LogIngester] Failed to open write-ahead-log; continuing with in-memory queue only:", streamError);
            LogIngester.#writeStream = null;
        }
    }

    static #toWriteAheadLogRecord(logEntryDocument)
    {
        const timestamp = logEntryDocument.timestamp instanceof Date ? logEntryDocument.timestamp.toISOString() : logEntryDocument.timestamp;
        return { ...logEntryDocument, timestamp: timestamp };
    }

    static #fromWriteAheadLogRecord(record)
    {
        return { ...record, timestamp: record.timestamp ? new Date(record.timestamp) : new Date() };
    }

    /**
     * Called by Logger for every entry. Appends to the write-ahead-log (durability)
     * and enqueues for the next MongoDB flush. Never throws — logging must not
     * break the caller.
     */
    static write(logEntryDocument)
    {
        try
        {
            LogIngester.#ensureWriteStream();
            if (LogIngester.#writeStream)
            {
                LogIngester.#writeStream.write(`${JSON.stringify(LogIngester.#toWriteAheadLogRecord(logEntryDocument))}\n`);
                LogIngester.#linesSinceRotate++;
            }

            LogIngester.#pendingQueue.push(logEntryDocument);
            if (LogIngester.#pendingQueue.length >= LogIngester.#MAXIMUM_BATCH_SIZE)
            {
                LogIngester.#flush();
            }
        }
        catch (writeError)
        {
            console.error("[LogIngester] write failed:", writeError);
        }
    }

    static async #flush()
    {
        if (LogIngester.#bFlushing)
        {
            return;
        }
        if (LogIngester.#pendingQueue.length === 0)
        {
            LogIngester.#rotateIfDrained();
            return;
        }
        LogIngester.#bFlushing = true;

        const batch = LogIngester.#pendingQueue.slice(0, LogIngester.#MAXIMUM_BATCH_SIZE);
        try
        {
            // Insert copies so a retry (on failure) never re-sends documents the
            // driver has already stamped with an _id.
            await LogEventQueryEngine.insertMany(batch.map(entry => ({ ...entry })));
            LogIngester.#pendingQueue.splice(0, batch.length);
            LogIngester.#rotateIfDrained();
        }
        catch (flushError)
        {
            // Leave the batch in the queue and the entries in the write-ahead-log;
            // the next tick retries. Nothing is dropped.
            console.error("[LogIngester] flush to logEvents failed; will retry:", flushError?.message || flushError);
        }
        finally
        {
            LogIngester.#bFlushing = false;
        }
    }

    /**
     * When the queue is fully drained, everything written so far is safely in
     * MongoDB, so the current write-ahead-log file can be deleted. Rotating by
     * recreate (rather than truncating a live file descriptor) avoids any race and
     * keeps the on-disk log tiny.
     */
    static #rotateIfDrained()
    {
        if (LogIngester.#pendingQueue.length !== 0 || LogIngester.#linesSinceRotate === 0 || !LogIngester.#writeStream)
        {
            return;
        }

        const oldStream = LogIngester.#writeStream;
        const oldPath = LogIngester.#writeAheadLogPath;
        LogIngester.#writeStream = null;
        LogIngester.#writeAheadLogPath = null;
        LogIngester.#linesSinceRotate = 0;

        oldStream.end(() =>
        {
            try { fs.unlinkSync(oldPath); } catch (unlinkError) { }
        });
    }

    static async #drainOrphanedWriteAheadLogs()
    {
        let fileNames = [];
        try
        {
            fileNames = fs.readdirSync(LogIngester.#WRITE_AHEAD_LOG_DIRECTORY);
        }
        catch (readError)
        {
            return;
        }

        for (const fileName of fileNames)
        {
            if (!fileName.endsWith(".ndjson"))
            {
                continue;
            }

            const filePath = path.join(LogIngester.#WRITE_AHEAD_LOG_DIRECTORY, fileName);
            if (filePath === LogIngester.#writeAheadLogPath)
            {
                continue;
            }

            try
            {
                const contents = fs.readFileSync(filePath, "utf-8");
                const documents = [];
                for (const line of contents.split("\n"))
                {
                    const trimmed = line.trim();
                    if (trimmed.length === 0)
                    {
                        continue;
                    }
                    try
                    {
                        documents.push(LogIngester.#fromWriteAheadLogRecord(JSON.parse(trimmed)));
                    }
                    catch (parseError)
                    {
                        // A torn final line from a crash mid-write — skip it.
                    }
                }

                for (let index = 0; index < documents.length; index += LogIngester.#MAXIMUM_BATCH_SIZE)
                {
                    await LogEventQueryEngine.insertMany(documents.slice(index, index + LogIngester.#MAXIMUM_BATCH_SIZE));
                }

                fs.unlinkSync(filePath);
            }
            catch (drainError)
            {
                // If MongoDB is still down at boot, leave the file for the next
                // start — never delete unread data.
                console.error(`[LogIngester] Could not drain ${fileName} yet; leaving for retry:`, drainError?.message || drainError);
            }
        }
    }
}

module.exports = LogIngester;
