const SupportTicketQueryEngine = require("../Database/SupportTicketQueryEngine");

/**
 * SupportTicketQuota
 *
 * The per-user submission allowance for the Report Issue flow.
 *
 * Counted in MongoDB rather than through the in-memory RateLimiter used for
 * per-second request throttling: that limiter's buckets live in the Dock process
 * and vanish on restart, which for a *daily* allowance would hand every user a
 * fresh quota on each deploy. Counting the reports themselves makes the limit
 * durable and exactly as accurate as the data it protects.
 *
 * The window is a rolling 24 hours rather than a calendar day, so the limit does
 * not depend on which time zone the server happens to think in and a user cannot
 * spend two allowances back to back across a midnight boundary.
 */
class SupportTicketQuota
{
    static MAXIMUM_REPORTS_PER_DAY = 2;
    static WINDOW_MILLISECONDS = 24 * 60 * 60 * 1000;

    /**
     * Reports whether the user may submit another report right now.
     *
     * Read-only — unlike RateLimiter.consume() this does not itself count the
     * attempt, because the attempt is recorded by the report insert that follows.
     * That ordering also means a submission rejected for a bad attachment does not
     * burn part of the allowance.
     *
     * KNOWN LIMITATION: because the slot is not reserved, simultaneous requests
     * can each read the same count and all pass, letting a user who deliberately
     * fires N requests at once store slightly more than the limit. Closing that
     * would need an atomic reserve-then-release counter, which is a lot of
     * machinery for a ceiling whose purpose is discouraging spam rather than
     * enforcing an entitlement — the sequential path a real user takes is exact,
     * and the per-IP RateLimiter still caps request volume. Revisit if the quota
     * ever gates something with real cost.
     *
     * @param {string} userId
     * @returns {Promise<{allowed: boolean, limit: number, used: number, remaining: number, retryAfterSeconds: number}>}
     */
    static async check(userId)
    {
        const windowStart = Date.now() - SupportTicketQuota.WINDOW_MILLISECONDS;
        const usedCount = await SupportTicketQueryEngine.countReportsForUserSince(userId, windowStart);
        const allowed = usedCount < SupportTicketQuota.MAXIMUM_REPORTS_PER_DAY;

        return {
            allowed: allowed,
            limit: SupportTicketQuota.MAXIMUM_REPORTS_PER_DAY,
            used: usedCount,
            remaining: Math.max(0, SupportTicketQuota.MAXIMUM_REPORTS_PER_DAY - usedCount),
            retryAfterSeconds: allowed ? 0 : await SupportTicketQuota.#secondsUntilAllowanceFrees(userId)
        };
    }

    /**
     * How long until the oldest report inside the window falls out of it — i.e.
     * when one slot actually frees up. Falls back to the full window length when
     * the reports cannot be read, which is the conservative answer.
     *
     * @param {string} userId
     * @returns {Promise<number>}
     */
    static async #secondsUntilAllowanceFrees(userId)
    {
        const fullWindowSeconds = Math.ceil(SupportTicketQuota.WINDOW_MILLISECONDS / 1000);

        try
        {
            const recentReports = await SupportTicketQueryEngine.listReportsForUser(userId);
            const windowStart = Date.now() - SupportTicketQuota.WINDOW_MILLISECONDS;
            const reportsInWindow = recentReports.filter(report => report.createdAt >= windowStart);

            if (reportsInWindow.length === 0)
            {
                return 0;
            }

            // listReportsForUser returns newest first, so the last entry inside the
            // window is the one that expires soonest.
            const oldestReportInWindow = reportsInWindow[reportsInWindow.length - 1];
            const freesAt = oldestReportInWindow.createdAt + SupportTicketQuota.WINDOW_MILLISECONDS;

            return Math.max(1, Math.ceil((freesAt - Date.now()) / 1000));
        }
        catch (quotaError)
        {
            console.warn(`[SupportTicketQuota] Could not compute the retry delay: ${quotaError?.message || quotaError}`);
            return fullWindowSeconds;
        }
    }
}

module.exports = SupportTicketQuota;
