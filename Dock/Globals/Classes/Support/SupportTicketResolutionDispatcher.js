const SupportTicketQueryEngine = require("../Database/SupportTicketQueryEngine");
const CreditLedger = require("../Credits/CreditLedger");
const EmailSender = require("../Email/EmailSender");
const NotificationDispatcher = require("../Notifications/NotificationDispatcher");
const NotificationContent = require("../Notifications/NotificationContent");
const { creditTransactionTypes } = require("../../Enumerations/CreditTransactionTypes");
const { notificationChannels } = require("../../Enumerations/NotificationChannels");
const { supportTicketStatus } = require("../../Enumerations/SupportTicketStatus");

/**
 * SupportTicketResolutionDispatcher
 *
 * Fans a single resolve / decline decision back out to everyone who reported the
 * problem: the credit reward to every reporter, the email and in-app notification
 * to the ones who asked for them.
 *
 * Runs in the background rather than inside the admin's request. A widely-reported
 * issue can easily carry hundreds of reporters, and sending that many SES messages
 * inline would blow past any reasonable request timeout — the admin gets an
 * immediate 202 with the counts instead.
 *
 * Everything here is designed to be safe to run twice on the same ticket:
 *   - Credit grants are keyed on `supportTicket:{ticketId}:{userId}`, so
 *     CreditLedger's reference-key idempotence makes a replay a no-op.
 *   - Reports are claimed by stamping notifiedAt, and each batch only reads rows
 *     where that is still null.
 * That combination is what lets SupportTicketDispatchReconciler safely finish a
 * dispatch that a restart interrupted halfway through.
 */
class SupportTicketResolutionDispatcher
{
    static BATCH_SIZE = 100;

    // A guard against an unbounded loop if a report somehow refuses to be marked
    // dispatched (e.g. it was deleted mid-run) — without it the same batch would
    // be re-read forever.
    static MAXIMUM_BATCHES = 200;

    /**
     * Delivers the outcome of one closed ticket to its reporters.
     *
     * Never throws: a failed email or a failed push must not abort the rest of the
     * fan-out, and this is always invoked without an awaiting caller.
     *
     * @param {SupportTicket} supportTicket a ticket already moved to RESOLVED or DECLINED
     * @returns {Promise<{processedCount: number, creditedCount: number, notifiedCount: number}>}
     */
    static async dispatch(supportTicket)
    {
        const ticketId = supportTicket.getId();
        const creditsPerReporter = supportTicket.getCreditsPerReporter();
        const bResolved = supportTicket.getStatus() === supportTicketStatus.RESOLVED;

        const reporterSummary = await SupportTicketQueryEngine.summariseReporters(ticketId);
        const existingDispatchState = supportTicket.getDispatchState();

        // Carried forward so a dispatch RESUMED by the reconciler reports total
        // coverage rather than only what this invocation happened to do. Without
        // it, finishing the last 5 of 300 reporters would tell the admin "5 of
        // 300" — reading as though 295 people were missed.
        let processedCount = Number(existingDispatchState?.processedCount) || 0;
        let creditedCount = 0;
        let notifiedCount = 0;
        let bReachedEnd = false;

        // A person who reported the same problem twice (the daily quota allows
        // two, and deduplication is designed to merge them onto one ticket) has
        // two report rows but is ONE reporter. Paying and emailing per report
        // would send them a second "we've added N credits" message for credits
        // the ledger's reference key correctly refused to grant twice.
        const reportersHandledThisRun = new Set();

        await SupportTicketQueryEngine.updateDispatchState(ticketId,
        {
            startedAt: existingDispatchState?.startedAt || Date.now(),
            completedAt: null,
            processedCount: processedCount,
            totalCount: reporterSummary.reportRowCount
        });

        try
        {
            for (let batchIndex = 0; batchIndex < SupportTicketResolutionDispatcher.MAXIMUM_BATCHES; batchIndex++)
            {
                const reports = await SupportTicketQueryEngine.listUndispatchedReports(ticketId, SupportTicketResolutionDispatcher.BATCH_SIZE);

                if (reports.length === 0)
                {
                    bReachedEnd = true;
                    break;
                }

                for (const report of reports)
                {
                    const bAlreadyHandledThisReporter = reportersHandledThisRun.has(report.getUserId());
                    const outcome = bAlreadyHandledThisReporter
                        ? { bCreditGranted: false, bNotified: false, creditAmount: 0 }
                        : await SupportTicketResolutionDispatcher.#deliverToReporter(supportTicket, report, creditsPerReporter, bResolved);

                    reportersHandledThisRun.add(report.getUserId());

                    processedCount++;
                    if (outcome.bCreditGranted)
                    {
                        creditedCount++;
                    }
                    if (outcome.bNotified)
                    {
                        notifiedCount++;
                    }

                    // Stamped even when delivery failed. A reporter who could not be
                    // emailed (a bounced address, SES down) must not wedge the whole
                    // ticket into being retried forever — the failure is logged, and
                    // the outcome is still visible to them in "Your reports".
                    await SupportTicketQueryEngine.markReportDispatched(report.getId(), outcome);
                }

                await SupportTicketQueryEngine.updateDispatchState(ticketId,
                {
                    startedAt: existingDispatchState?.startedAt || Date.now(),
                    completedAt: null,
                    processedCount: processedCount,
                    totalCount: reporterSummary.reportRowCount
                });
            }
        }
        catch (dispatchError)
        {
            console.error(`[SupportTicketResolutionDispatcher] Fan-out failed part-way for ticket ${ticketId}: ${dispatchError?.message || dispatchError}`);

            // Deliberately left incomplete (completedAt stays null) so the
            // reconciler picks the ticket up and finishes the remaining reports.
            return { processedCount: processedCount, creditedCount: creditedCount, notifiedCount: notifiedCount, bComplete: false };
        }

        // completedAt is stamped ONLY when a batch came back empty, which is the
        // one exit that proves every report was reached. Exhausting the batch
        // bound means reports remain — claiming completion there would hide the
        // ticket from listTicketsWithIncompleteDispatch forever, permanently
        // stranding the reporters it never got to.
        if (!bReachedEnd)
        {
            console.warn(`[SupportTicketResolutionDispatcher] Ticket ${ticketId} hit the ${SupportTicketResolutionDispatcher.MAXIMUM_BATCHES}-batch bound with reports still undispatched; leaving it for the reconciler.`);
            return { processedCount: processedCount, creditedCount: creditedCount, notifiedCount: notifiedCount, bComplete: false };
        }

        await SupportTicketQueryEngine.updateDispatchState(ticketId,
        {
            startedAt: existingDispatchState?.startedAt || Date.now(),
            completedAt: Date.now(),
            processedCount: processedCount,
            totalCount: reporterSummary.reportRowCount
        });

        console.log(`[SupportTicketResolutionDispatcher] Ticket ${ticketId}: ${processedCount} reporters processed, ${creditedCount} credited, ${notifiedCount} notified.`);

        return { processedCount: processedCount, creditedCount: creditedCount, notifiedCount: notifiedCount, bComplete: true };
    }

    /**
     * Credits, emails and notifies one reporter.
     *
     * The credit grant runs for every reporter; the email and notification only for
     * those who opted in. Each delivery channel is independently guarded so one
     * failure does not cost the reporter the others.
     *
     * @param {SupportTicket} supportTicket
     * @param {SupportTicketReport} report
     * @param {number} creditsPerReporter
     * @param {boolean} bResolved
     * @returns {Promise<{bCreditGranted: boolean, bNotified: boolean, creditAmount: number}>}
     */
    static async #deliverToReporter(supportTicket, report, creditsPerReporter, bResolved)
    {
        let bCreditGranted = false;
        let grantedAmount = 0;

        // Credits are the compensation for having reported the problem, so they are
        // not conditional on the notification opt-in — declining an email is not
        // declining a reward. Only a resolution earns them; a decline does not.
        if (bResolved && creditsPerReporter > 0 && report.getUserId().length > 0)
        {
            try
            {
                const referenceKey = `supportTicket:${supportTicket.getId()}:${report.getUserId()}`;
                const grantOutcome = await CreditLedger.grant
                (
                    report.getUserId(),
                    creditsPerReporter,
                    creditTransactionTypes.SUPPORT_TICKET_GRANT,
                    referenceKey,
                    { ticketId: supportTicket.getId(), reportId: report.getId(), reason: "Support ticket resolution reward" }
                );

                // Only a genuinely APPLIED grant counts. CreditLedger reports
                // alreadyApplied for any previously-seen reference key, including
                // one whose transaction was REJECTED because the user no longer
                // exists — treating that as success would stamp creditAmount on
                // the report and tell a deleted account it had been paid.
                bCreditGranted = grantOutcome.applied === true;
                grantedAmount = bCreditGranted ? creditsPerReporter : 0;
            }
            catch (grantError)
            {
                console.warn(`[SupportTicketResolutionDispatcher] Credit grant failed for report ${report.getId()}: ${grantError?.message || grantError}`);
            }
        }

        if (!report.getNotifyOnResolution())
        {
            return { bCreditGranted: bCreditGranted, bNotified: false, creditAmount: grantedAmount };
        }

        let bNotified = false;

        if (report.getUserEmail().length > 0)
        {
            try
            {
                if (bResolved)
                {
                    await EmailSender.sendSupportTicketResolvedEmail(report.getUserEmail(), supportTicket.getTitle(), supportTicket.getResolutionMessage(), grantedAmount);
                }
                else
                {
                    await EmailSender.sendSupportTicketDeclinedEmail(report.getUserEmail(), supportTicket.getTitle(), supportTicket.getDeclineMessage());
                }

                bNotified = true;
            }
            catch (emailError)
            {
                console.warn(`[SupportTicketResolutionDispatcher] Resolution email failed for report ${report.getId()}: ${emailError?.message || emailError}`);
            }
        }

        try
        {
            const notificationBody = bResolved
                ? NotificationContent.supportTicketResolved(supportTicket.getId(), grantedAmount)
                : NotificationContent.supportTicketDeclined(supportTicket.getId());

            await NotificationDispatcher.dispatch(report.getUserId(), notificationBody, notificationChannels.IN_APP | notificationChannels.PUSH);
            bNotified = true;
        }
        catch (notifyError)
        {
            console.warn(`[SupportTicketResolutionDispatcher] Notification failed for report ${report.getId()}: ${notifyError?.message || notifyError}`);
        }

        return { bCreditGranted: bCreditGranted, bNotified: bNotified, creditAmount: grantedAmount };
    }
}

module.exports = SupportTicketResolutionDispatcher;
