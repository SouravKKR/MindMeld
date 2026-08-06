import SpreadsheetWriter from "../SpreadsheetWriter.js";

/**
 * CreditDistributionPreviewSheetBuilder
 *
 * Turns a distribution preview into a spreadsheet the administrator can read,
 * check and keep before any credits move.
 *
 * It lists ONLY the people who would actually receive credits. A sheet padded
 * with every member of the organization, most of them at zero, buries the thing
 * it exists to let someone verify: who is getting this, and how much.
 *
 * Every row shows the balance before, the amount, and the balance after,
 * because "granted 20" alone cannot be sanity-checked — 20 credits onto an
 * empty balance and onto a balance of 900 are very different decisions.
 */
class CreditDistributionPreviewSheetBuilder
{
    static #HEADERS = ["Email", "Name", "Tags", "Credits before", "Credits granted", "Credits after", "Capped by monthly limit"];

    /**
     * @param {object} preview the /Organization/Credits/Distribute/Preview body
     * @returns {Array<Array<*>>} rows ready for SpreadsheetWriter
     */
    static buildRows(preview)
    {
        const recipients = Array.isArray(preview?.recipients) ? preview.recipients : [];
        const payingRecipients = recipients.filter(recipient => Number(recipient.granted) > 0);

        const rows = [CreditDistributionPreviewSheetBuilder.#HEADERS.slice()];

        for (const recipient of payingRecipients)
        {
            rows.push
            ([
                recipient.email,
                recipient.displayName || "",
                Array.isArray(recipient.tags) ? recipient.tags.join("; ") : "",
                recipient.balanceBefore,
                recipient.granted,
                recipient.balanceAfter,
                recipient.clampedByMonthlyCap ? "Yes" : "No"
            ]);
        }

        // A summary block, separated by a blank row so a spreadsheet's own
        // sorting and filtering still treat the rows above as one table.
        rows.push([]);
        rows.push(["Recipients", payingRecipients.length]);
        rows.push(["Per person", preview?.perUserAmount ?? 0]);
        rows.push(["Total credits", preview?.totalAmount ?? 0]);
        rows.push(["Pool before", preview?.poolBalanceBefore ?? 0]);
        rows.push(["Pool after", preview?.poolBalanceAfter ?? 0]);

        return rows;
    }

    /**
     * Downloads the preview as a workbook.
     * @param {object} preview
     * @param {string} organizationName
     */
    static download(preview, organizationName)
    {
        const datePart = new Date().toISOString().slice(0, 10);
        SpreadsheetWriter.downloadWorkbook
        (
            CreditDistributionPreviewSheetBuilder.buildRows(preview),
            `CogniumLearn-CreditDistribution-${organizationName}-${datePart}`,
            "Distribution"
        );
    }
}

export default CreditDistributionPreviewSheetBuilder;
