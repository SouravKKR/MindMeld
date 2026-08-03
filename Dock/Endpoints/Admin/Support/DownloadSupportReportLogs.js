const { PassThrough } = require("stream");
const SupportTicketQueryEngine = require("../../../Globals/Classes/Database/SupportTicketQueryEngine");
const LogExportService = require("../../../Globals/Classes/Logging/LogExportService");
const { httpStatus } = require("../../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../../Globals/Constants/ErrorCodes");

/**
 * GET /Admin/Support/Report/Logs?reportId=...&format=log|html
 * GET /Admin/Support/Report/Logs?ticketId=...&format=log|html   (zipped bundle)
 *
 * Pulls the server logs surrounding a support report so the admin can see what
 * actually happened, without hunting through the general log console for a time
 * window and an account id.
 *
 * Window: the 24 hours ENDING at the moment the report was submitted. A reporter
 * describes something that already went wrong, so the useful evidence is behind
 * the timestamp, not ahead of it.
 *
 * Scope: the reporter's own account id PLUS unattributed entries (accountId ""),
 * which is where server events and uncaught errors land. That combination gives
 * the errors and system activity around the problem while excluding every other
 * identifiable user's operations — an admin debugging one person's bug has no
 * business reading a different person's session.
 *
 * The hot/cold merge is what makes this work at all for an older report: the log
 * archival scheduler empties the live collection on each run, so anything beyond
 * the last run exists only as NDJSON in cloud storage. LogExportService reads
 * both halves.
 */

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

// A ticket-wide bundle is capped so a heavily-reported issue cannot turn one click
// into hundreds of archive reads. When the cap bites it is logged AND surfaced in
// the archive itself — a silently truncated bundle reads as full coverage.
const MAXIMUM_REPORTS_PER_BUNDLE = 20;

async function downloadSupportReportLogs(request, response)
{
    try
    {
        const queryParameters = await request.getQueryParams();
        const reportId = typeof queryParameters?.reportId === "string" ? queryParameters.reportId.trim() : "";
        const ticketId = typeof queryParameters?.ticketId === "string" ? queryParameters.ticketId.trim() : "";
        const format = queryParameters?.format === "html" ? "html" : "log";

        if (reportId.length > 0)
        {
            await sendSingleReportLogs(reportId, format, response);
            return;
        }

        if (ticketId.length > 0)
        {
            await sendTicketBundle(ticketId, format, response);
            return;
        }

        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_ID });
    }
    catch (exportError)
    {
        console.error(`[DownloadSupportReportLogs] ${exportError?.message || exportError}`);

        if (!response.headersSent)
        {
            response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
            response.sendJson({ error: ErrorCodes.SUPPORT_LOG_EXPORT_FAILED, reason: exportError?.message || "" });
        }
    }
}

/**
 * @param {SupportTicketReport} report
 * @param {string} format
 * @returns {Promise<{body: string, entryCount: number, bTruncated: boolean}>}
 */
async function collectLogsForReport(report, format)
{
    const toDate = new Date(report.getCreatedAt());
    const fromDate = new Date(report.getCreatedAt() - MILLISECONDS_PER_DAY);

    const collection = await LogExportService.collectEntries
    ({
        fromDate: fromDate,
        toDate: toDate,
        accountIds: [report.getUserId(), LogExportService.UNATTRIBUTED_ACCOUNT_ID]
    });

    return {
        body: LogExportService.renderSegment(collection.entries, format),
        entryCount: collection.entries.length,
        bTruncated: collection.bTruncated
    };
}

/**
 * @param {string} reportId
 * @param {string} format
 * @param {object} response
 * @returns {Promise<void>}
 */
async function sendSingleReportLogs(reportId, format, response)
{
    const report = await SupportTicketQueryEngine.getReport(reportId);

    if (report === null)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ error: ErrorCodes.SUPPORT_REPORT_NOT_FOUND });
        return;
    }

    const logs = await collectLogsForReport(report, format);
    const extension = LogExportService.resolveExtension(format);
    const fileName = `support_${reportId}_${fileNameTimestamp(report.getCreatedAt())}.${extension}`;

    response.setHeader("Content-Type", LogExportService.resolveContentType(format));
    response.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    response.end(logs.body);
}

/**
 * One log file per reporter, zipped. Useful when the same problem was reported
 * from several accounts and the shared failure only shows up by comparison.
 *
 * @param {string} ticketId
 * @param {string} format
 * @param {object} response
 * @returns {Promise<void>}
 */
async function sendTicketBundle(ticketId, format, response)
{
    const reports = await SupportTicketQueryEngine.listReportsForTicket(ticketId);

    if (reports.length === 0)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ error: ErrorCodes.SUPPORT_REPORT_NOT_FOUND });
        return;
    }

    const includedReports = reports.slice(0, MAXIMUM_REPORTS_PER_BUNDLE);
    const omittedCount = reports.length - includedReports.length;

    if (omittedCount > 0)
    {
        console.warn(`[DownloadSupportReportLogs] Ticket ${ticketId} has ${reports.length} reports; bundling the first ${MAXIMUM_REPORTS_PER_BUNDLE} and omitting ${omittedCount}.`);
    }

    const extension = LogExportService.resolveExtension(format);
    const segments = [];

    for (const report of includedReports)
    {
        const logs = await collectLogsForReport(report, format);
        segments.push
        ({
            name: `${fileNameTimestamp(report.getCreatedAt())}_${report.getId()}.${extension}`,
            body: logs.body
        });
    }

    // The manifest is what keeps a capped bundle honest: whoever opens the zip can
    // see exactly which reporters it does and does not cover.
    segments.push
    ({
        name: "MANIFEST.txt",
        body: buildManifest(ticketId, reports, includedReports, omittedCount)
    });

    const zipBuffer = await buildZipBuffer(segments);

    response.setHeader("Content-Type", "application/zip");
    response.setHeader("Content-Disposition", `attachment; filename="support_${ticketId}_logs.zip"`);
    response.end(zipBuffer);
}

/**
 * @param {string} ticketId
 * @param {Array<SupportTicketReport>} allReports
 * @param {Array<SupportTicketReport>} includedReports
 * @param {number} omittedCount
 * @returns {string}
 */
function buildManifest(ticketId, allReports, includedReports, omittedCount)
{
    const lines =
    [
        `Support ticket: ${ticketId}`,
        `Reports on this ticket: ${allReports.length}`,
        `Reports included in this bundle: ${includedReports.length}`,
        `Reports omitted (bundle cap ${MAXIMUM_REPORTS_PER_BUNDLE}): ${omittedCount}`,
        ``,
        `Each file covers the 24 hours ending at that report's submission time, and`,
        `contains only that reporter's log entries plus unattributed system entries.`,
        ``,
        `Included reports:`
    ];

    for (const report of includedReports)
    {
        lines.push(`  ${report.getId()}  ${new Date(report.getCreatedAt()).toISOString()}  ${report.getUserEmail()}`);
    }

    return lines.join("\n") + "\n";
}

/**
 * Filename-safe UTC timestamp (colons to dashes, milliseconds dropped).
 *
 * @param {number} utcMilliseconds
 * @returns {string}
 */
function fileNameTimestamp(utcMilliseconds)
{
    const date = new Date(utcMilliseconds);

    if (Number.isNaN(date.getTime()))
    {
        return "unknown";
    }

    return date.toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
}

/**
 * Buffers a zip in memory, mirroring the approach in the admin log download —
 * these archives are small enough that streaming would add complexity for no gain.
 *
 * @param {Array<{name: string, body: string}>} segments
 * @returns {Promise<Buffer>}
 */
async function buildZipBuffer(segments)
{
    let archiver = null;

    try
    {
        archiver = require("archiver");
    }
    catch (archiverError)
    {
        throw new Error("bundling support logs requires the archiver dependency");
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
        zip.append(segment.body, { name: segment.name });
    }

    await zip.finalize();
    await completion;

    return Buffer.concat(chunks);
}

module.exports = { downloadSupportReportLogs };
