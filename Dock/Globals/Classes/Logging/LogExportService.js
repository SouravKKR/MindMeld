const LogEventQueryEngine = require("./LogEventQueryEngine");
const LogArchiveQueryEngine = require("./LogArchiveQueryEngine");
const LogFormatter = require("./LogFormatter");
const Persistence = require("../Persistence");
const { storageTargets } = require("../../Enumerations/StorageTargets");

/**
 * LogExportService
 *
 * Assembles a log export from BOTH halves of the storage model and renders it.
 *
 * The split matters: LogArchivalScheduler moves entries out of the hot logEvents
 * collection into NDJSON objects in cloud storage and then deletes them, so any
 * window older than the last archival run exists only in the archives. Reading
 * just one half silently returns an incomplete export — which for a support
 * ticket means the very logs that explain a bug are the ones missing.
 *
 * Extracted so the unrestricted admin download (/Admin/Logs/Download) and the
 * per-report support export (/Admin/Support/Report/Logs) share one implementation
 * of the merge, the ordering and the rendering rather than drifting apart.
 */
class LogExportService
{
    static MAXIMUM_ENTRIES = 500000;

    // Marks unattributed entries — server events and errors that belong to no
    // particular account. Included alongside a specific account so a scoped export
    // still carries the system-level context around the user's activity.
    static UNATTRIBUTED_ACCOUNT_ID = "";

    /**
     * Reads the hot window and every overlapping cold archive, applies the same
     * filters to both, and returns the merged entries sorted oldest-first.
     *
     * @param {{fromDate: Date, toDate: Date, levels: Array<number>|null, accountIds: Array<string>|null, maximumEntries: number}} exportRequest
     * @returns {Promise<{entries: Array<object>, bTruncated: boolean}>}
     */
    static async collectEntries({ fromDate, toDate, levels = null, accountIds = null, maximumEntries = LogExportService.MAXIMUM_ENTRIES })
    {
        const levelSet = Array.isArray(levels) && levels.length > 0 ? new Set(levels.map(Number)) : null;
        const accountIdSet = Array.isArray(accountIds) && accountIds.length > 0 ? new Set(accountIds.map(accountId => String(accountId ?? ""))) : null;
        const entryCap = Number.isFinite(maximumEntries) && maximumEntries > 0 ? maximumEntries : LogExportService.MAXIMUM_ENTRIES;

        const hotEntries = await LogEventQueryEngine.queryRange
        ({
            fromDate: fromDate,
            toDate: toDate,
            levels: levels,
            accountIds: accountIds,
            limit: entryCap
        });

        const overlappingArchives = await LogArchiveQueryEngine.findOverlapping(fromDate, toDate);
        let coldEntries = [];
        let bTruncated = false;

        for (const archive of overlappingArchives)
        {
            const archiveEntries = await LogExportService.#readArchiveEntries(archive, fromDate, toDate, levelSet, accountIdSet);
            coldEntries = coldEntries.concat(archiveEntries);

            if (hotEntries.length + coldEntries.length > entryCap)
            {
                console.warn(`[LogExportService] Entry cap ${entryCap} reached; older archived entries were truncated from this export.`);
                bTruncated = true;
                break;
            }
        }

        const allEntries = hotEntries.concat(coldEntries);
        LogExportService.sortEntries(allEntries);

        return { entries: allEntries, bTruncated: bTruncated };
    }

    /**
     * Reads and filters one cold archive object. A single unreadable archive must
     * not fail the whole export — the rest of the range is still worth returning —
     * so a read failure is logged and treated as an empty archive.
     *
     * @param {object} archive
     * @param {Date} fromDate
     * @param {Date} toDate
     * @param {Set<number>|null} levelSet
     * @param {Set<string>|null} accountIdSet
     * @returns {Promise<Array<object>>}
     */
    static async #readArchiveEntries(archive, fromDate, toDate, levelSet, accountIdSet)
    {
        let text = "";

        try
        {
            const buffer = await Persistence.read(archive.storagePath, storageTargets.LINODE_OBJECT_STORAGE);
            text = buffer.toString("utf-8");
        }
        catch (readError)
        {
            console.error(`[LogExportService] Failed to read archive ${archive.storagePath}: ${readError?.message || readError}`);
            return [];
        }

        const entries = [];

        for (const line of text.split("\n"))
        {
            const trimmedLine = line.trim();

            if (trimmedLine.length === 0)
            {
                continue;
            }

            let entry = null;

            try
            {
                entry = JSON.parse(trimmedLine);
            }
            catch (parseError)
            {
                continue;
            }

            const timestamp = entry.timestamp ? new Date(entry.timestamp) : null;

            if (timestamp && (timestamp < fromDate || timestamp > toDate))
            {
                continue;
            }
            if (levelSet && !levelSet.has(Number(entry.level)))
            {
                continue;
            }
            if (accountIdSet && !accountIdSet.has(String(entry.accountId ?? "")))
            {
                continue;
            }

            entries.push(entry);
        }

        return entries;
    }

    /**
     * Oldest-first, with the in-process sequence counter breaking ties between
     * entries written in the same millisecond.
     *
     * @param {Array<object>} entries
     * @returns {void}
     */
    static sortEntries(entries)
    {
        entries.sort((leftEntry, rightEntry) =>
        {
            const leftTime = new Date(leftEntry.timestamp).getTime() || 0;
            const rightTime = new Date(rightEntry.timestamp).getTime() || 0;

            if (leftTime !== rightTime)
            {
                return leftTime - rightTime;
            }

            return (Number(leftEntry.sequence) || 0) - (Number(rightEntry.sequence) || 0);
        });
    }

    /**
     * @param {Array<object>} entries
     * @param {string} format "html" for the colour-coded document, anything else for plain text
     * @returns {string}
     */
    static renderSegment(entries, format)
    {
        if (format === "html")
        {
            return LogFormatter.renderHtmlDocument(entries);
        }

        return entries.map(entry => LogFormatter.formatLine(entry)).join("\n") + (entries.length > 0 ? "\n" : "");
    }

    /**
     * @param {string} format
     * @returns {string}
     */
    static resolveExtension(format)
    {
        return format === "html" ? "html" : "log";
    }

    /**
     * @param {string} format
     * @returns {string}
     */
    static resolveContentType(format)
    {
        return format === "html" ? "text/html; charset=utf-8" : "text/plain; charset=utf-8";
    }
}

module.exports = LogExportService;
