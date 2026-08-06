const FinancialReconciliationService = require("../../../Globals/Classes/Payments/FinancialReconciliationService");
const {httpStatus} = require("../../../Globals/Enumerations/HttpStatus");

/**
 * GET /Admin/Reconciliation/List
 *
 * The daily reconciliation reports, newest first — the evidence that the
 * internal reconciliation actually ran, and what it found.
 *
 * Query params (all optional):
 *   limit=<n>  — how many days to return (default 60, capped at 400)
 */
async function listReconciliations(request, response)
{
    const query = (await request.getQueryParams()) || {};
    const limit = query.limit !== undefined ? Number(query.limit) : undefined;

    try
    {
        const reports = await FinancialReconciliationService.listReports(limit);

        response.statusCode = httpStatus.OK;
        response.sendJson({ reports: reports });
    }
    catch (listError)
    {
        console.error(`[ListReconciliations] ${listError.message}`);
        response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
        response.sendJson({ error: "Failed to list reconciliation reports." });
    }
}

module.exports = { listReconciliations };
