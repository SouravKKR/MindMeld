const FinancialReconciliationService = require("../../../Globals/Classes/Payments/FinancialReconciliationService");
const {httpStatus} = require("../../../Globals/Enumerations/HttpStatus");

const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const JOURNAL_COLUMNS = ["date", "flow", "reference", "accountId", "description", "grossMinor", "currency"];

/**
 * GET /Admin/Reconciliation/ExportJournal?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * One CSV row per settled transaction in the range, for import into the
 * accounting system. This is the other half of the accounting hop: the
 * accountant needs a machine-readable statement of what this server believes it
 * took before they can hand back the figure that
 * /Admin/Reconciliation/RecordAccountingTotals compares against.
 *
 * Reversals appear as NEGATIVE gross, so the file sums to the net figure the
 * bank will show rather than to the gross this server collected.
 */
async function exportJournal(request, response)
{
    const query = (await request.getQueryParams()) || {};
    const fromDayKey = typeof query.from === "string" ? query.from.trim() : "";
    const toDayKey = typeof query.to === "string" ? query.to.trim() : "";

    if (!DAY_KEY_PATTERN.test(fromDayKey) || !DAY_KEY_PATTERN.test(toDayKey))
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: "from and to must both be YYYY-MM-DD dates." });
        return;
    }

    try
    {
        const journalRows = await FinancialReconciliationService.buildJournalRows(fromDayKey, toDayKey);

        const csvLines = [JOURNAL_COLUMNS.join(",")];
        for (const journalRow of journalRows)
        {
            csvLines.push(JOURNAL_COLUMNS.map(columnName => escapeCsvValue(journalRow[columnName])).join(","));
        }

        response.statusCode = httpStatus.OK;
        response.setHeader("Content-Type", "text/csv; charset=utf-8");
        response.setHeader("Content-Disposition", `attachment; filename="CogniumLearn-Journal-${fromDayKey}-to-${toDayKey}.csv"`);
        response.end(`${csvLines.join("\n")}\n`);
    }
    catch (exportError)
    {
        console.error(`[ExportJournal] ${exportError.message}`);
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: exportError.message || "Failed to build the journal export." });
    }
}

/**
 * A reference or description can legitimately contain a comma or a quote, and a
 * spreadsheet that splits one row into two is a reconciliation artefact nobody
 * can trust. Quote everything that needs it, doubling embedded quotes per RFC
 * 4180.
 */
function escapeCsvValue(rawValue)
{
    const stringValue = rawValue === null || rawValue === undefined ? "" : String(rawValue);

    if (/[",\n\r]/.test(stringValue))
    {
        return `"${stringValue.split("\"").join("\"\"")}"`;
    }

    return stringValue;
}

module.exports = { exportJournal };
