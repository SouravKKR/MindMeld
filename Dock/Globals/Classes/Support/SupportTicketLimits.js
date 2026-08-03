/**
 * SupportTicketLimits
 *
 * Every size ceiling in the support-ticket subsystem, in one place.
 *
 * These matter more than a usual input cap because a grouped ticket is rewritten
 * by the LLM on every merge: without hard ceilings the canonical description and
 * the aspects array grow on each duplicate report until the document approaches
 * the 16 MB BSON limit, the re-embedding input degenerates into noise, and every
 * subsequent deduplication prompt costs more than the last.
 *
 * Two different enforcement styles are deliberate:
 *   - User-supplied text is REJECTED when it overruns. A reporter must never
 *     believe they sent detail that was silently discarded.
 *   - LLM-produced text is CLAMPED (truncated at a word boundary). Failing a
 *     deduplication run over a cosmetic overrun would be a worse outcome than a
 *     slightly shortened description.
 *
 * The Agent workflow mirrors these values as module constants — the enum/constant
 * codegen does not cover this file, so the two copies are hand-synchronised. See
 * Agent/Workflows/DeduplicateSupportTicket/DeduplicateSupportTicket.py.
 */
class SupportTicketLimits
{
    // ── Reporter-supplied text (rejected on overrun) ────────────────────────
    static MINIMUM_DESCRIPTION_LENGTH = 20;
    static MAXIMUM_DESCRIPTION_LENGTH = 4000;

    // ── LLM-produced ticket text (clamped on overrun) ───────────────────────
    static MAXIMUM_TICKET_DESCRIPTION_LENGTH = 8000;
    static MAXIMUM_ASPECT_LENGTH = 1000;
    static MAXIMUM_TITLE_LENGTH = 200;

    // Past this many distinct aspects a ticket stops absorbing new text but keeps
    // counting reporters. Fifty separate aspects means the grouping has become too
    // coarse and wants a human split, not more prose.
    static MAXIMUM_ASPECTS_PER_TICKET = 50;

    // ── Admin-supplied resolution text (rejected on overrun) ────────────────
    static MAXIMUM_RESOLUTION_MESSAGE_LENGTH = 4000;
    static MAXIMUM_DECLINE_MESSAGE_LENGTH = 4000;

    // Ceiling for the per-reporter credit incentive, so a mistyped figure cannot
    // drain the credit pool across a ticket with hundreds of reporters.
    static MAXIMUM_CREDITS_PER_REPORTER = 1000;

    /**
     * Truncates at the last word boundary at or before the limit, so clamped LLM
     * output ends on a whole word rather than mid-token. Returns the input
     * untouched when it already fits.
     *
     * @param {string} rawText
     * @param {number} maximumLength
     * @returns {string}
     */
    static clampToWordBoundary(rawText, maximumLength)
    {
        const text = String(rawText ?? "").trim();

        if (text.length <= maximumLength)
        {
            return text;
        }

        const hardTruncation = text.slice(0, maximumLength);
        const lastSpaceIndex = hardTruncation.lastIndexOf(" ");

        // Only honour the word boundary when it does not throw away most of the
        // allowance (a single very long token would otherwise collapse to nothing).
        if (lastSpaceIndex > maximumLength / 2)
        {
            return hardTruncation.slice(0, lastSpaceIndex).trim();
        }

        return hardTruncation.trim();
    }
}

module.exports = SupportTicketLimits;
