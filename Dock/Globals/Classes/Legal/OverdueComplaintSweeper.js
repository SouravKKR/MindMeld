const IntellectualPropertyComplaintQueryEngine = require("../Database/IntellectualPropertyComplaintQueryEngine");
const AdminEmailQueryEngine = require("../Database/AdminEmailQueryEngine");
const AuthenticationQueryEngine = require("../Database/AuthenticationQueryEngine");
const NotificationDispatcher = require("../Notifications/NotificationDispatcher");
const NotificationContent = require("../Notifications/NotificationContent");
const ComplaintAcknowledger = require("./ComplaintAcknowledger");
const IntellectualPropertyComplaintConstants = require("../../Constants/IntellectualPropertyComplaintConstants");
const { notificationChannels } = require("../../Enumerations/NotificationChannels");
const { intellectualPropertyComplaintStatus } = require("../../Enumerations/IntellectualPropertyComplaintStatus");

/**
 * OverdueComplaintSweeper — watches the clocks the Terms of Service commit to,
 * and tells the administrators before those clocks run out.
 *
 * Follows the reaper convention already in this codebase
 * (ExpiredInformationSourceReaper, LapsedPaidDeckReaper): a bounded periodic
 * tick, a single-runner guard, an unref'd interval, and failure means
 * retry-next-tick rather than crash.
 *
 * ── What it does NOT do ────────────────────────────────────────────────────
 *
 * It never disposes of a complaint, never removes content and never restores
 * it. Every one of those is a decision, and a job that made them would be
 * making them at 3am on the strength of an elapsed timer. What it does is make
 * sure nobody can miss a deadline quietly — the failure mode this closes is a
 * complaint sitting unread for sixteen days while the platform believes it is
 * meeting a fifteen-day commitment it published.
 *
 * ── The acknowledgment backstop ────────────────────────────────────────────
 *
 * The 24-hour acknowledgment is sent by ComplaintAcknowledger the moment a
 * complaint is stored, not here. This sweeper only retries the ones whose email
 * failed — which is why it checks `acknowledgedAt` rather than assuming the
 * primary path worked. A sweeper that OWNED the acknowledgment would satisfy
 * "within 24 hours" only by accident of how often it happened to tick.
 *
 * ── Why the reminders are idempotent-by-status, not by a stored flag ───────
 *
 * Nothing records "we already warned about this one". The tick interval and the
 * warning window are chosen so a still-open complaint produces a small, bounded
 * number of reminders, and that is the correct behaviour: a legal deadline
 * that is still unmet SHOULD keep saying so. A stored "notified" flag would
 * make the platform go quiet about a breach after mentioning it once, which is
 * exactly backwards.
 */
class OverdueComplaintSweeper
{
    static #TICK_INTERVAL_MILLISECONDS = 6 * 60 * 60 * 1000;
    static #INITIAL_DELAY_MILLISECONDS = 120 * 1000;
    static #SWEEP_LIMIT = 200;

    // How far ahead of a deadline the first warning goes out. A day's notice on
    // a fifteen-day commitment is enough to act on and late enough not to be
    // noise.
    static #WARNING_LEAD_MILLISECONDS = 24 * 60 * 60 * 1000;

    static #intervalHandle = null;
    static #bRunning = false;

    static start()
    {
        if (OverdueComplaintSweeper.#intervalHandle !== null)
        {
            return;
        }

        OverdueComplaintSweeper.#intervalHandle = setInterval(
            () => { OverdueComplaintSweeper.#tick(); },
            OverdueComplaintSweeper.#TICK_INTERVAL_MILLISECONDS);

        if (typeof OverdueComplaintSweeper.#intervalHandle.unref === "function")
        {
            OverdueComplaintSweeper.#intervalHandle.unref();
        }

        // One deferred sweep shortly after boot, once the database has settled —
        // so a restart does not have to wait a full interval to notice that
        // something went overdue while the process was down.
        const initialTimer = setTimeout(
            () => { OverdueComplaintSweeper.#tick(); },
            OverdueComplaintSweeper.#INITIAL_DELAY_MILLISECONDS);

        if (typeof initialTimer.unref === "function")
        {
            initialTimer.unref();
        }
    }

    static async #tick()
    {
        if (OverdueComplaintSweeper.#bRunning)
        {
            return;
        }
        OverdueComplaintSweeper.#bRunning = true;

        try
        {
            const nowMilliseconds = Date.now();
            const openComplaints = await IntellectualPropertyComplaintQueryEngine.findOpenReceivedBefore(
                nowMilliseconds,
                OverdueComplaintSweeper.#SWEEP_LIMIT);

            if (openComplaints.length === 0)
            {
                return;
            }

            const administratorUserIds = await OverdueComplaintSweeper.#resolveAdministratorUserIds();

            let retriedAcknowledgmentCount = 0;
            let alertCount = 0;

            for (const complaint of openComplaints)
            {
                if (complaint.getAcknowledgedAt() === null)
                {
                    // The primary send failed. Retry it here rather than only
                    // reporting it: an acknowledgment that is late is still worth
                    // far more to the complainant than one that never comes.
                    const bAcknowledged = await ComplaintAcknowledger.acknowledge(complaint);

                    if (bAcknowledged)
                    {
                        retriedAcknowledgmentCount++;
                    }
                    else if (nowMilliseconds > complaint.getAcknowledgmentDeadline())
                    {
                        alertCount += await OverdueComplaintSweeper.#alertAdministrators(
                            administratorUserIds,
                            NotificationContent.intellectualPropertyComplaintDeadline(
                                complaint.getReference(),
                                "24-hour acknowledgment",
                                ComplaintAcknowledger.formatDeadline(complaint.getAcknowledgmentDeadline()),
                                true));
                    }
                }

                const disposalDeadline = complaint.getDisposalDeadline();

                if (nowMilliseconds > disposalDeadline - OverdueComplaintSweeper.#WARNING_LEAD_MILLISECONDS)
                {
                    alertCount += await OverdueComplaintSweeper.#alertAdministrators(
                        administratorUserIds,
                        NotificationContent.intellectualPropertyComplaintDeadline(
                            complaint.getReference(),
                            `${IntellectualPropertyComplaintConstants.DISPOSAL_DAYS}-day disposal deadline`,
                            ComplaintAcknowledger.formatDeadline(disposalDeadline),
                            nowMilliseconds > disposalDeadline));
                }

                const blockExpiryDeadline = complaint.getBlockExpiryDeadline();

                // Only meaningful once access has actually been disabled, and
                // only worth saying once the window has fully run — restoring
                // early would be the platform breaking the block it promised.
                if (blockExpiryDeadline !== null
                    && nowMilliseconds > blockExpiryDeadline
                    && complaint.getCurrentStatus() === intellectualPropertyComplaintStatus.ACCESS_DISABLED)
                {
                    alertCount += await OverdueComplaintSweeper.#alertAdministrators(
                        administratorUserIds,
                        NotificationContent.intellectualPropertyBlockWindowElapsed(
                            complaint.getReference(),
                            ComplaintAcknowledger.formatDeadline(blockExpiryDeadline)));
                }
            }

            if (retriedAcknowledgmentCount > 0 || alertCount > 0)
            {
                console.log(
                    `[OverdueComplaintSweeper] Swept ${openComplaints.length} open complaint(s) — ` +
                    `${retriedAcknowledgmentCount} acknowledgment(s) retried, ${alertCount} administrator alert(s) sent.`);
            }
        }
        catch (sweepError)
        {
            console.error(`[OverdueComplaintSweeper] Sweep failed: ${sweepError?.message || sweepError}`);
        }
        finally
        {
            OverdueComplaintSweeper.#bRunning = false;
        }
    }

    /**
     * The accounts that should hear about a deadline.
     *
     * Resolved from the admin-email allowlist rather than from a role field on
     * users, because that allowlist is the source of truth for who is an
     * administrator — a role on a user document is downstream of it and is only
     * reconciled at login, so a newly-appointed admin who has not signed in yet
     * would be missed.
     *
     * An admin email with no account behind it yet is skipped rather than
     * failing the sweep: they cannot receive a notification until they exist.
     *
     * @returns {Promise<string[]>}
     */
    static async #resolveAdministratorUserIds()
    {
        let administratorRows = [];

        try
        {
            administratorRows = await AdminEmailQueryEngine.listAdmins();
        }
        catch (listError)
        {
            console.warn(`[OverdueComplaintSweeper] Could not list administrators: ${listError?.message || listError}`);
            return [];
        }

        const administratorUserIds = [];

        for (const administratorRow of (administratorRows || []))
        {
            const administratorEmail = String(administratorRow?.email ?? "").trim().toLowerCase();

            if (administratorEmail.length === 0)
            {
                continue;
            }

            try
            {
                const administratorUser = await AuthenticationQueryEngine.getUserByEmail(administratorEmail);

                if (administratorUser)
                {
                    administratorUserIds.push(administratorUser.getId());
                }
            }
            catch (lookupError)
            {
                console.warn(`[OverdueComplaintSweeper] Could not resolve the administrator ${administratorEmail}: ${lookupError?.message || lookupError}`);
            }
        }

        return administratorUserIds;
    }

    /**
     * Fans one alert out to every administrator. In-app, push AND email: a
     * deadline in a published legal document should reach someone who is not
     * looking at the admin panel today.
     *
     * Best-effort per recipient — one failed push must not cost the others their
     * warning.
     *
     * @param {string[]} administratorUserIds
     * @param {object} notification
     * @returns {Promise<number>} Alerts delivered.
     */
    static async #alertAdministrators(administratorUserIds, notification)
    {
        let deliveredCount = 0;

        for (const administratorUserId of administratorUserIds)
        {
            try
            {
                await NotificationDispatcher.dispatch(
                    administratorUserId,
                    notification,
                    notificationChannels.IN_APP | notificationChannels.PUSH | notificationChannels.EMAIL);

                deliveredCount++;
            }
            catch (dispatchError)
            {
                console.warn(`[OverdueComplaintSweeper] Could not alert ${administratorUserId}: ${dispatchError?.message || dispatchError}`);
            }
        }

        return deliveredCount;
    }
}

module.exports = OverdueComplaintSweeper;
