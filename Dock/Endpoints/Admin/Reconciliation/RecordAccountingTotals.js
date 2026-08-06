const FinancialReconciliationService = require("../../../Globals/Classes/Payments/FinancialReconciliationService");
const {httpStatus} = require("../../../Globals/Enumerations/HttpStatus");

const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * POST /Admin/Reconciliation/RecordAccountingTotals
 *
 * Body: { dayKey: "YYYY-MM-DD", grossMinor: number, currency: string,
 *         source: string, note?: string }
 *
 * Enters what the accounting system holds for a day, so the daily
 * reconciliation can compare against something that is not this application.
 * Without this hop the reconciliation only proves the server agrees with
 * itself.
 *
 * The day is re-reconciled immediately rather than on the next sweep: whoever
 * just typed the figure is the right person to learn, while they are still
 * looking at it, that it does not match.
 *
 * `grossMinor` is in MINOR units (paise), matching every other amount in the
 * payment surface. A figure entered in rupees would be off by a factor of a
 * hundred and would reconcile as a break rather than silently — but it is
 * still the caller's most likely mistake, so the field name says minor.
 */
async function recordAccountingTotals(request, response)
{
    const requester = request.user;
    if (!requester)
    {
        response.sendStatusCode(httpStatus.UNAUTHORIZED);
        return;
    }

    let body;
    try
    {
        body = await request.getBody();
    }
    catch (bodyError)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: "Malformed JSON body." });
        return;
    }

    const dayKey = typeof body?.dayKey === "string" ? body.dayKey.trim() : "";
    const grossMinor = Number(body?.grossMinor);
    const currency = typeof body?.currency === "string" ? body.currency.trim() : "";
    const source = typeof body?.source === "string" ? body.source.trim() : "";
    const note = typeof body?.note === "string" ? body.note.trim() : "";

    if (!DAY_KEY_PATTERN.test(dayKey) || FinancialReconciliationService.parseDayKey(dayKey) === null)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: "dayKey must be a valid YYYY-MM-DD date." });
        return;
    }

    if (!Number.isFinite(grossMinor))
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: "grossMinor must be a number of minor units." });
        return;
    }

    if (source.length === 0)
    {
        // An unattributed figure is not evidence. Whoever reads this report in a
        // year has to know which system it came from.
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: "source is required — name the accounting system this figure came from." });
        return;
    }

    try
    {
        const report = await FinancialReconciliationService.recordAccountingTotals(dayKey,
        {
            grossMinor: grossMinor,
            currency: currency,
            source: source,
            recordedBy: requester.id || requester.email || "",
            note: note
        });

        // No explicit audit call: the ensureAdmin gate attaches
        // AdminActionAuditor to every admin request, and the report itself
        // stores recordedBy — which is the sign-off the settlement owner's
        // procedure actually depends on.
        response.statusCode = httpStatus.OK;
        response.sendJson({ report: report });
    }
    catch (recordError)
    {
        console.error(`[RecordAccountingTotals] ${recordError.message}`);
        response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
        response.sendJson({ error: "Failed to record the accounting totals." });
    }
}

module.exports = { recordAccountingTotals };
