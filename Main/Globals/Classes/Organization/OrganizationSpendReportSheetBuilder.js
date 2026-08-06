import SpreadsheetWriter from "../SpreadsheetWriter.js";

/**
 * OrganizationSpendReportSheetBuilder
 *
 * Renders the organization's spend report as a spreadsheet.
 *
 * The server's disclaimer is written into the sheet as its first row, not
 * merely shown on screen beside the download button. A file outlives the page
 * that produced it: whoever opens this later has to be able to see that the
 * spend column includes credits the member bought themselves, or they will
 * read every figure as institute money.
 */
class OrganizationSpendReportSheetBuilder
{
    static #FIXED_HEADERS = ["Email", "Name", "Tags", "Granted by organization", "Spent", "Remaining balance"];

    /**
     * @param {object} report the /Organization/Credits/SpendReport body's report
     * @returns {Array<Array<*>>}
     */
    static buildRows(report)
    {
        const categories = Array.isArray(report?.categories) ? report.categories : [];
        const rows = [];

        rows.push([report?.disclaimer || ""]);
        rows.push([]);
        rows.push([...OrganizationSpendReportSheetBuilder.#FIXED_HEADERS, ...categories]);

        for (const row of (Array.isArray(report?.rows) ? report.rows : []))
        {
            rows.push
            ([
                row.email,
                row.name || "",
                Array.isArray(row.tags) ? row.tags.join("; ") : "",
                row.grantedByOrganization,
                row.spent,
                row.remainingBalance,
                ...categories.map(category => row.spendByCategory?.[category] ?? 0)
            ]);
        }

        rows.push([]);
        rows.push(["Totals", "", "", report?.totals?.granted ?? 0, report?.totals?.spent ?? 0, report?.totals?.remaining ?? 0]);

        return rows;
    }

    static download(report, organizationName)
    {
        const datePart = new Date().toISOString().slice(0, 10);
        SpreadsheetWriter.downloadWorkbook
        (
            OrganizationSpendReportSheetBuilder.buildRows(report),
            `CogniumLearn-Spend-${organizationName}-${datePart}`,
            "Spend"
        );
    }
}

export default OrganizationSpendReportSheetBuilder;
