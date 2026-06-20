const fs = require("fs");
const CreditDealPaymentQueryEngine = require("../../../Globals/Classes/Credits/CreditDealPaymentQueryEngine");
const Persistence = require("../../../Globals/Classes/Persistence");
const { storageTargets } = require("../../../Globals/Enumerations/StorageTargets");
const ErrorCodes = require("../../../Globals/Constants/ErrorCodes");
const { httpStatus } = require("../../../Globals/Enumerations/HttpStatus");

const MAXIMUM_INVOICE_BYTES = 10 * 1024 * 1024;
const INVOICE_DIRECTORY = "CreditDealInvoices";
const ALLOWED_INVOICE_MIME_TYPES = new Set
([
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/webp",
    "image/gif"
]);

function sanitiseFileName(rawName)
{
    const base = String(rawName || "invoice").split(/[\\/]/).pop();
    const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200);
    return cleaned.length > 0 ? cleaned : "invoice";
}

/**
 * POST /Admin/Credits/Deals/UploadInvoice  (multipart, FILE_UPLOAD)
 *
 * Attaches (or replaces) the invoice file (PDF / image) for a deal. Upload-
 * later is fully supported — this is independent of deal creation. The bytes
 * land in the GCS bucket under CreditDealInvoices/{dealId}/; the deal row keeps
 * only the pointer + metadata.
 *
 * Metadata query param: { dealId, fileName, mimeType }. File under field "file".
 */
async function uploadDealInvoice(request, response)
{
    const queryParameters = await request.getQueryParams();

    let metadata = null;
    try
    {
        metadata = JSON.parse(queryParameters.metadata || "{}");
    }
    catch (parseError)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_BODY });
        return;
    }

    const dealId = typeof metadata.dealId === "string" ? metadata.dealId : "";
    if (dealId.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_ID });
        return;
    }

    const mimeType = typeof metadata.mimeType === "string" ? metadata.mimeType.toLowerCase() : "";
    if (!ALLOWED_INVOICE_MIME_TYPES.has(mimeType))
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_INVOICE_TYPE });
        return;
    }

    const deal = await CreditDealPaymentQueryEngine.getById(dealId);
    if (!deal)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ error: ErrorCodes.DEAL_NOT_FOUND });
        return;
    }

    const files = await request.getFiles();
    const uploadedFilePath = files?.file;
    if (!uploadedFilePath)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.MISSING_FIELDS });
        return;
    }

    let fileSizeBytes = 0;
    try
    {
        fileSizeBytes = fs.statSync(uploadedFilePath).size;
    }
    catch (statError)
    {
        fileSizeBytes = 0;
    }

    if (fileSizeBytes <= 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.MISSING_FIELDS });
        return;
    }
    if (fileSizeBytes > MAXIMUM_INVOICE_BYTES)
    {
        try { fs.unlinkSync(uploadedFilePath); } catch (cleanupError) { }
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVOICE_TOO_LARGE });
        return;
    }

    const fileName = sanitiseFileName(metadata.fileName);
    const bucketPath = `${INVOICE_DIRECTORY}/${dealId}/${fileName}`;

    try
    {
        await Persistence.move(uploadedFilePath, storageTargets.LOCAL_FILE_SYSTEM, bucketPath, storageTargets.GOOGLE_CLOUD_STORAGE);
    }
    catch (uploadError)
    {
        try { fs.unlinkSync(uploadedFilePath); } catch (cleanupError) { }
        console.error(`[UploadDealInvoice] GCS upload failed: ${uploadError?.message || uploadError}`);
        response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
        response.sendJson({ error: ErrorCodes.GCS_UPLOAD_FAILED, reason: uploadError?.message });
        return;
    }

    await CreditDealPaymentQueryEngine.attachInvoice(dealId, {
        fileName: fileName,
        mimeType: mimeType,
        bucketPath: bucketPath,
        sizeBytes: fileSizeBytes,
        now: new Date()
    });

    const updated = await CreditDealPaymentQueryEngine.getById(dealId);
    response.statusCode = httpStatus.OK;
    response.sendJson({ success: true, deal: updated ? updated.toJson() : deal.toJson() });
}

module.exports = { uploadDealInvoice };
