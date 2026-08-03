const SupportTicketQueryEngine = require("../Database/SupportTicketQueryEngine");
const SupportTicketResolutionDispatcher = require("./SupportTicketResolutionDispatcher");

/**
 * SupportTicketDispatchReconciler
 *
 * Boot-time recovery for resolution fan-outs that never finished.
 *
 * SupportTicketResolutionDispatcher runs in the ephemeral background of the admin's
 * resolve request — exactly the shape that loses work when the process restarts
 * mid-flight. Without this, a redeploy during a large fan-out would leave some
 * reporters emailed and credited and the rest silently skipped forever, with the
 * admin having no signal that anything was missed.
 *
 * Recovery is safe to run because the dispatcher is idempotent by construction:
 * credit grants are keyed on (ticketId, userId) so CreditLedger refuses a second
 * application, and only reports with a null notifiedAt are re-read. A reconciled
 * ticket therefore reaches exactly the reporters the interrupted run did not.
 *
 * The grace period matters: without it, a dispatch that is legitimately running
 * right now would be picked up and run a second time in parallel.
 */
class SupportTicketDispatchReconciler
{
    // A dispatch still incomplete this long after the ticket was closed is not in
    // flight — it belongs to a process that is gone.
    static GRACE_PERIOD_MILLISECONDS = 5 * 60 * 1000;

    static MAXIMUM_TICKETS_PER_RUN = 50;

    // Delay before the first sweep so it does not compete with the rest of
    // start-up (and so a brief restart during a dispatch is given a chance to be
    // the same process finishing normally).
    static BOOT_DELAY_MILLISECONDS = 90 * 1000;

    // A boot-only sweep would only ever recover work interrupted by a RESTART. A
    // dispatch can also strand itself in a long-lived process — a transient Mongo
    // error inside the fan-out returns with completedAt still null, and nothing
    // else retries it. On a server that runs for weeks, those reporters would wait
    // weeks for a redeploy. This periodic tick is what closes that gap.
    static SWEEP_INTERVAL_MILLISECONDS = 15 * 60 * 1000;

    static #bootTimer = null;
    static #sweepTimer = null;

    /**
     * Schedules the first sweep and the recurring one after it. Fire-and-forget: a
     * reconciliation failure must never keep Dock from serving.
     *
     * @returns {void}
     */
    static startOnBoot()
    {
        if (SupportTicketDispatchReconciler.#bootTimer !== null)
        {
            return;
        }

        SupportTicketDispatchReconciler.#bootTimer = setTimeout(() =>
        {
            SupportTicketDispatchReconciler.#runSweep();
            SupportTicketDispatchReconciler.#sweepTimer = SupportTicketDispatchReconciler.#unreferenced
            (
                setInterval(() => SupportTicketDispatchReconciler.#runSweep(), SupportTicketDispatchReconciler.SWEEP_INTERVAL_MILLISECONDS)
            );
        }, SupportTicketDispatchReconciler.BOOT_DELAY_MILLISECONDS);

        SupportTicketDispatchReconciler.#unreferenced(SupportTicketDispatchReconciler.#bootTimer);
    }

    /**
     * @returns {void}
     */
    static #runSweep()
    {
        SupportTicketDispatchReconciler.reconcile().catch(reconcileError =>
        {
            console.error(`[SupportTicketDispatchReconciler] Reconciliation sweep failed: ${reconcileError?.message || reconcileError}`);
        });
    }

    /**
     * Unrefs a timer so a pending sweep never holds the process open on its own.
     *
     * @param {object} timer
     * @returns {object}
     */
    static #unreferenced(timer)
    {
        if (timer && typeof timer.unref === "function")
        {
            timer.unref();
        }

        return timer;
    }

    /**
     * Finds closed tickets whose fan-out never completed and finishes them.
     *
     * @returns {Promise<number>} how many tickets were re-dispatched
     */
    static async reconcile()
    {
        const closedBefore = Date.now() - SupportTicketDispatchReconciler.GRACE_PERIOD_MILLISECONDS;
        const strandedTickets = await SupportTicketQueryEngine.listTicketsWithIncompleteDispatch(closedBefore, SupportTicketDispatchReconciler.MAXIMUM_TICKETS_PER_RUN);

        if (strandedTickets.length === 0)
        {
            return 0;
        }

        console.log(`[SupportTicketDispatchReconciler] Found ${strandedTickets.length} support ticket(s) with an unfinished resolution fan-out.`);

        let reconciledCount = 0;

        for (const supportTicket of strandedTickets)
        {
            try
            {
                await SupportTicketResolutionDispatcher.dispatch(supportTicket);
                reconciledCount++;
            }
            catch (dispatchError)
            {
                console.error(`[SupportTicketDispatchReconciler] Could not finish the fan-out for ticket ${supportTicket.getId()}: ${dispatchError?.message || dispatchError}`);
            }
        }

        return reconciledCount;
    }
}

module.exports = SupportTicketDispatchReconciler;
