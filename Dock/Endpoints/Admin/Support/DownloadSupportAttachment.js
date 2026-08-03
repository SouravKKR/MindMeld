const SupportTicketQueryEngine = require("../../../Globals/Classes/Database/SupportTicketQueryEngine");
const Persistence = require("../../../Globals/Classes/Persistence");
const { storageTargets } = require("../../../Globals/Enumerations/StorageTargets");
const { httpStatus } = require("../../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../../Globals/Constants/ErrorCodes");

/**
 * GET /Admin/Support/Report/Attachment?reportId=...&fileName=...
 *
 * Serves one attachment from a support report, inline so screenshots open in the
 * browser rather than downloading.
 *
 * The storage path is never taken from the request. The report is loaded from
 * Mongo and the requested file name is matched against its recorded attachment
 * list; the path that comes back from that record is the only one ever read. A
 * client-supplied path — even one that looked well-formed — would be a directory
 * traversal into the bucket.
 */
async function downloadSupportAttachment(request, response)
{
    const queryParameters = await request.getQueryParams();
    const reportId = typeof queryParameters?.reportId === "string" ? queryParameters.reportId.trim() : "";
    const requestedFileName = typeof queryParameters?.fileName === "string" ? queryParameters.fileName.trim() : "";

    if (reportId.length === 0 || requestedFileName.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_ID });
        return;
    }

    const report = await SupportTicketQueryEngine.getReport(reportId);

    if (report === null)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ error: ErrorCodes.SUPPORT_REPORT_NOT_FOUND });
        return;
    }

    const attachment = report.getAttachments().find(candidate => candidate.fileName === requestedFileName);

    if (!attachment || attachment.storagePath.length === 0)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ error: ErrorCodes.SUPPORT_ATTACHMENT_NOT_FOUND });
        return;
    }

    let fileData = null;

    try
    {
        fileData = await Persistence.read(attachment.storagePath, storageTargets.LINODE_OBJECT_STORAGE);
    }
    catch (readError)
    {
        console.error(`[DownloadSupportAttachment] Read failed for report ${reportId}: ${readError?.message || readError}`);
        response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
        response.sendJson({ error: ErrorCodes.SUPPORT_ATTACHMENT_NOT_FOUND });
        return;
    }

    response.setHeader("Content-Type", attachment.mimeType || "application/octet-stream");
    response.setHeader("Content-Disposition", `inline; filename="${attachment.fileName}"`);
    response.end(fileData);
}

module.exports = { downloadSupportAttachment };
