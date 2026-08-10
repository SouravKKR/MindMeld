const EmailSender = require("../Email/EmailSender");
const IntellectualPropertyComplaintQueryEngine = require("../Database/IntellectualPropertyComplaintQueryEngine");

/**
 * ComplaintAcknowledger — sends the acknowledgment Clause 19.2 of the Terms
 * promises within twenty-four hours, and records that it went.
 *
 * ── Why this fires on the insert, not on a timer ────────────────────────────
 *
 * The commitment is "within 24 hours". A scheduled job that swept for
 * unacknowledged complaints would satisfy that only by accident of how often it
 * ticked, and would be silently skipped for the one complaint whose row never
 * reached a queue — which is exactly the complaint whose acknowledgment matters
 * most. Sending it the moment the record is durable makes the promise a
 * property of storing a complaint rather than of a background process staying
 * alive.
 *
 * The sweeper (OverdueComplaintSweeper) still exists, but as a backstop that
 * catches an acknowledgment which failed to send, not as the primary path.
 *
 * ── Why it never throws ─────────────────────────────────────────────────────
 *
 * A complaint that is stored but not acknowledged is a late acknowledgment. A
 * complaint that was refused because SES was down is a notice the platform did
 * not receive. The second is far worse, so an email failure is logged, left
 * visible in `acknowledgedAt` staying null, and never allowed to fail the
 * submission that produced it.
 */
class ComplaintAcknowledger
{
    /**
     * Writes to the complainant and stamps the record when it lands.
     *
     * @param {import("../../Model/IntellectualPropertyComplaint")} complaint
     * @returns {Promise<boolean>} True when the acknowledgment was delivered.
     */
    static async acknowledge(complaint)
    {
        if (!complaint || complaint.getContactEmail().length === 0)
        {
            return false;
        }

        try
        {
            await EmailSender.sendIntellectualPropertyComplaintAcknowledgmentEmail
            (
                complaint.getContactEmail(),
                complaint.getReference(),
                ComplaintAcknowledger.formatDeadline(complaint.getDisposalDeadline())
            );
        }
        catch (acknowledgmentError)
        {
            console.error(`[ComplaintAcknowledger] Could not acknowledge complaint ${complaint.getReference()}: ${acknowledgmentError?.message || acknowledgmentError}`);
            return false;
        }

        try
        {
            await IntellectualPropertyComplaintQueryEngine.markAcknowledged(complaint.getId());
        }
        catch (stampError)
        {
            // The mail went out; only the record of it failed. Warn rather than
            // report failure, because reporting failure here would make the
            // sweeper send a second acknowledgment for a complaint that has
            // already had one.
            console.warn(`[ComplaintAcknowledger] Acknowledged ${complaint.getReference()} but could not stamp the record: ${stampError?.message || stampError}`);
        }

        return true;
    }

    /**
     * A deadline as a date a person can read, in UTC.
     *
     * Deliberately UTC and deliberately spelled out. The recipient is somewhere
     * unknown, the commitment is measured in absolute time, and "15 August 2026
     * (UTC)" cannot be misread as a different day the way a bare local-format
     * date can.
     *
     * @param {number} deadlineMilliseconds
     * @returns {string}
     */
    static formatDeadline(deadlineMilliseconds)
    {
        const deadlineDate = new Date(Number(deadlineMilliseconds) || Date.now());

        const dayNumber = deadlineDate.getUTCDate();
        const monthName = ComplaintAcknowledger.MONTH_NAMES[deadlineDate.getUTCMonth()];
        const yearNumber = deadlineDate.getUTCFullYear();

        return `${dayNumber} ${monthName} ${yearNumber} (UTC)`;
    }

    static MONTH_NAMES =
    [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December"
    ];
}

module.exports = ComplaintAcknowledger;
