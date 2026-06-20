const CreditDealPaymentQueryEngine = require("../../../Globals/Classes/Credits/CreditDealPaymentQueryEngine");
const Persistence = require("../../../Globals/Classes/Persistence");
const { storageTargets } = require("../../../Globals/Enumerations/StorageTargets");
const ErrorCodes = require("../../../Globals/Constants/ErrorCodes");
const { httpStatus } = require("../../../Globals/Enumerations/HttpStatus");

/**
 * GET /Admin/Credits/Deals/Invoice?dealId=...
 *
 * Streams the stored invoice file back to the admin. Mirrors the
 * InformationSourceDownload header contract.
 */
async function downloadDealInvoice(request, response)
{
    const queryParameters = await request.getQueryParams();
    const dealId = queryParameters["dealId"];

    if (typeof dealId !== "string" || dealId.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_ID });
        return;
    }

    const deal = await CreditDealPaymentQueryEngine.getById(dealId);
    if (!deal || deal.getHasInvoice() !== true || deal.getInvoiceBucketPath().length === 0)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ error: ErrorCodes.NOT_FOUND });
        return;
    }

    let fileData;
    try
    {
        fileData = await Persistence.read(deal.getInvoiceBucketPath(), storageTargets.GOOGLE_CLOUD_STORAGE);
    }
    catch (readError)
    {
        console.error(`[DownloadDealInvoice] Read failed for ${dealId}: ${readError?.message || readError}`);
        response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
        response.sendJson({ error: ErrorCodes.NOT_FOUND });
        return;
    }

    response.setHeader("Content-Type", deal.getInvoiceMimeType() || "application/octet-stream");
    response.setHeader("Content-Disposition", `inline; filename="${deal.getInvoiceFileName() || "invoice"}"`);
    response.end(fileData);
}

module.exports = { downloadDealInvoice };
