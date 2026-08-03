const SupportTicketQueryEngine = require("../Database/SupportTicketQueryEngine");
const SupportAttachmentPolicy = require("./SupportAttachmentPolicy");
const EphemeralUploadRegistry = require("../Content/EphemeralUploadRegistry");

/**
 * SupportAttachmentPurger — removes the files attached to a support ticket once
 * the ticket is closed.
 *
 * Attachments are screenshots users take of their own screens. They routinely
 * contain that user's study material, and sometimes third-party content that
 * happens to be on screen. Their entire purpose is to let a human diagnose one
 * report; once that report is resolved or declined, keeping the images serves
 * nobody and simply accumulates other people's content on the platform.
 *
 * Attachments are stored per REPORT, while resolution happens per TICKET, and a
 * ticket deduplicates many reports of the same issue. Purging therefore has to
 * walk the ticket's reports — deleting only the folder of the report that
 * happened to create the ticket would leave every duplicate's attachments
 * behind, which is precisely the kind of partial cleanup that looks done and is
 * not.
 *
 * This is the EAGER path. EphemeralUploadRegistry independently holds a
 * retention-window record for every attachment folder, so a ticket that is never
 * actioned still gets swept. Both paths converge on the same purge, and the
 * registry row is removed by it, so running both is harmless.
 */
class SupportAttachmentPurger
{
    /**
     * Purges every attachment belonging to every report on one ticket.
     *
     * Best-effort and never throws: this runs after a ticket has already been
     * resolved or declined, and failing that user-visible action because a
     * screenshot could not be deleted would be the wrong trade. A failure leaves
     * the registry record in place, so the reaper retries it later.
     *
     * @param {string} ticketId
     * @return {Promise<number>} Report folders purged.
     */
    static async purgeForTicket(ticketId)
    {
        if (typeof ticketId !== "string" || ticketId.length === 0)
        {
            return 0;
        }

        try
        {
            const ticketReports = await SupportTicketQueryEngine.listReportsForTicket(ticketId);

            let purgedReportCount = 0;

            for (const ticketReport of (ticketReports || []))
            {
                const reportId = typeof ticketReport?.getId === "function" ? ticketReport.getId() : ticketReport?.id;

                if (typeof reportId !== "string" || reportId.length === 0)
                {
                    continue;
                }

                await EphemeralUploadRegistry.purgePrefix(SupportAttachmentPolicy.buildStoragePrefix(reportId));
                purgedReportCount++;
            }

            if (purgedReportCount > 0)
            {
                console.log(`[SupportAttachmentPurger] Purged attachments for ${purgedReportCount} report(s) on ticket ${ticketId}.`);
            }

            return purgedReportCount;
        }
        catch (purgeError)
        {
            console.warn(`[SupportAttachmentPurger] Could not purge attachments for ticket ${ticketId}: ${purgeError?.message || purgeError}`);
            return 0;
        }
    }
}

module.exports = SupportAttachmentPurger;
