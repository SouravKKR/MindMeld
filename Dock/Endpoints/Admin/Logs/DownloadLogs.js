const { PassThrough } = require("stream");
const LogExportService = require("../../../Globals/Classes/Logging/LogExportService");
const ErrorCodes = require("../../../Globals/Constants/ErrorCodes");
const { httpStatus } = require("../../../Globals/Enumerations/HttpStatus");

/**
 * GET /Admin/Logs/Download?fromDate&toDate&levels&split&format
 *
 * Streams the logs in a date range as a downloadable file, merging the hot
 * MongoDB window with any overlapping cold cloud-storage archives so ANY range is
 * downloadable (requirement 4). `levels` is a comma-separated list of LogLevel
 * values (requirement 5's level filter). `format` is "log" (plain, default) or
 * "html" (colour-coded by severity). `split` is "none" (default) or
 * "hours:N" / "days:N" / "lines:N", which produces a .zip of segments.
 *
 * The hot/cold merge and the rendering live in LogExportService, shared with the
 * per-report support-ticket export (/Admin/Support/Report/Logs); this handler owns
 * only the query-string parsing, the segmentation and the HTTP response.
 */

const MILLISECONDS_PER_HOUR = 60 * 60 * 1000;
const MILLISECONDS_PER_DAY = 24 * MILLISECONDS_PER_HOUR;

function parseLevels(rawLevels)
{
    if (typeof rawLevels !== "string" || rawLevels.trim().length === 0)
    {
        return null;
    }
    const levels = rawLevels.split(",").map(part => Number(part.trim())).filter(value => Number.isInteger(value));
    return levels.length > 0 ? levels : null;
}

function parseDate(rawValue, fallback)
{
    if (typeof rawValue !== "string" || rawValue.length === 0)
    {
        return fallback;
    }
    const parsed = new Date(rawValue);
    return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

// Filename-safe UTC timestamp (colons -> dashes, milliseconds dropped), e.g.
// 2026-07-05T14-32-10Z, so a split file's name can carry the range it covers.
function fileNameTimestamp(isoLike)
{
    const date = new Date(isoLike);
    if (Number.isNaN(date.getTime()))
    {
        return "unknown";
    }
    return date.toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
}

// Appends the actual first -> last entry range to a split file's base name, so
// the filename tells you exactly what the file covers (entries are already sorted
// ascending, so [0] is earliest and the last element is latest).
function nameWithRange(baseName, segmentEntries)
{
    if (segmentEntries.length === 0)
    {
        return baseName;
    }
    const fromStamp = fileNameTimestamp(segmentEntries[0].timestamp);
    const toStamp = fileNameTimestamp(segmentEntries[segmentEntries.length - 1].timestamp);
    return `${baseName}_${fromStamp}_to_${toStamp}`;
}

function splitEntries(entries, split)
{
    if (!split || split === "none")
    {
        return [{ name: "logs", entries: entries }];
    }

    const [mode, rawAmount] = String(split).split(":");
    const amount = Math.max(1, Math.floor(Number(rawAmount) || 0));

    if (mode === "lines")
    {
        const segments = [];
        for (let index = 0; index < entries.length; index += amount)
        {
            const segmentEntries = entries.slice(index, index + amount);
            segments.push({ name: nameWithRange(`logs_part_${segments.length + 1}`, segmentEntries), entries: segmentEntries });
        }
        return segments.length > 0 ? segments : [{ name: "logs", entries: [] }];
    }

    if (mode === "hours" || mode === "days")
    {
        const windowMilliseconds = amount * (mode === "hours" ? MILLISECONDS_PER_HOUR : MILLISECONDS_PER_DAY);
        const entriesByBucket = new Map();
        for (const entry of entries)
        {
            const time = new Date(entry.timestamp).getTime() || 0;
            const bucketIndex = Math.floor(time / windowMilliseconds);
            if (!entriesByBucket.has(bucketIndex))
            {
                entriesByBucket.set(bucketIndex, []);
            }
            entriesByBucket.get(bucketIndex).push(entry);
        }

        return Array.from(entriesByBucket.keys()).sort((left, right) => left - right).map(bucketIndex =>
        {
            const segmentEntries = entriesByBucket.get(bucketIndex);
            return { name: nameWithRange("logs", segmentEntries), entries: segmentEntries };
        });
    }

    return [{ name: "logs", entries: entries }];
}

async function buildZipBuffer(segments, format, extension)
{
    let archiver;
    try
    {
        archiver = require("archiver");
    }
    catch (archiverError)
    {
        throw new Error("split archive requires the archiver dependency");
    }

    const zip = archiver("zip", { zlib: { level: 9 } });
    const collector = new PassThrough();
    const chunks = [];
    collector.on("data", chunk => chunks.push(chunk));

    const completion = new Promise((resolve, reject) =>
    {
        collector.on("end", resolve);
        collector.on("error", reject);
        zip.on("error", reject);
    });

    zip.pipe(collector);
    for (const segment of segments)
    {
        zip.append(LogExportService.renderSegment(segment.entries, format), { name: `${segment.name}.${extension}` });
    }
    await zip.finalize();
    await completion;

    return Buffer.concat(chunks);
}

async function downloadLogs(request, response)
{
    try
    {
        const queryParameters = await request.getQueryParams();
        const fromDate = parseDate(queryParameters.fromDate, new Date(0));
        const toDate = parseDate(queryParameters.toDate, new Date());
        const levels = parseLevels(queryParameters.levels);
        const split = typeof queryParameters.split === "string" ? queryParameters.split : "none";
        const format = queryParameters.format === "html" ? "html" : "log";
        const extension = LogExportService.resolveExtension(format);

        const collection = await LogExportService.collectEntries({ fromDate, toDate, levels });
        const segments = splitEntries(collection.entries, split);

        if (segments.length <= 1)
        {
            const body = LogExportService.renderSegment(segments[0] ? segments[0].entries : [], format);
            response.setHeader("Content-Type", LogExportService.resolveContentType(format));
            response.setHeader("Content-Disposition", `attachment; filename="logs.${extension}"`);
            response.end(body);
            return;
        }

        const zipBuffer = await buildZipBuffer(segments, format, extension);
        response.setHeader("Content-Type", "application/zip");
        response.setHeader("Content-Disposition", `attachment; filename="logs.zip"`);
        response.end(zipBuffer);
    }
    catch (downloadError)
    {
        console.error(`[DownloadLogs] ${downloadError?.message || downloadError}`);
        if (!response.headersSent)
        {
            response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
            response.sendJson({ error: ErrorCodes.LOG_DOWNLOAD_FAILED, reason: downloadError?.message || "" });
        }
    }
}

// sortEntries moved to LogExportService when the hot/cold merge was extracted for
// reuse by the support-ticket log export; splitEntries stays here because
// segmentation is a download-endpoint concern (and is unit-tested against it).
module.exports = { downloadLogs, splitEntries };
