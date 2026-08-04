const TaskManager = require("./TaskManager");
const TaskStateManager = require("./TaskStateManager");
const TaskHistoryQueryEngine = require("../Database/TaskHistoryQueryEngine");
const Persistence = require("../Persistence");
const PersistenceConstants = require("../../Constants/PersistenceConstants");
const { taskStatus } = require("../../Enumerations/TaskStatus");
const NotificationDispatcher = require("../Notifications/NotificationDispatcher");
const NotificationContent = require("../Notifications/NotificationContent");


/**
 * Boot-time recovery for generation runs whose in-process Dock driver died
 * mid-post-pipeline (restart / redeploy / crash). The post-pipeline tail
 * (image pipeline + moveToDatabase + the marker clear) runs in the ephemeral
 * background handler of the /Generate request; if the process dies while a slow
 * "Enhance Images" step is running, the PostPipeline marker is left "pending"
 * forever and GetProgress shows a phantom "generation finalization" node that
 * never completes.
 *
 * This settles each orphan into the SAME resumable outcome the live pipeline
 * uses for an incomplete post-pipeline image step (root FAILED + a resumable
 * snapshot) and clears the marker, so the phantom node disappears and the home
 * PausedTaskBanner offers Resume. Recovery is manual (banner), by design.
 */
class OrphanedGenerationReconciler
{
    /**
     * Runs once, right after TaskManager connects. Any post-pipeline marker
     * still "pending" at boot is by definition orphaned — nothing in THIS
     * freshly-started process is driving it. A short-lived boot lock keeps a
     * future multi-Dock deployment from double-settling the same runs.
     */
    static async reconcileOnBoot()
    {
        const bLockAcquired = await TaskManager.acquireReconcileLock();
        if (!bLockAcquired)
        {
            console.log("[OrphanedGenerationReconciler] Another node holds the boot reconcile lock — skipping.");
            return;
        }

        try
        {
            const pendingMainTaskIds = await TaskManager.listPendingPostPipelineMainTaskIds();
            if (pendingMainTaskIds.length === 0)
            {
                return;
            }

            console.log(`[OrphanedGenerationReconciler] Found ${pendingMainTaskIds.length} orphaned post-pipeline run(s) to settle.`);

            for (const mainTaskId of pendingMainTaskIds)
            {
                try
                {
                    await OrphanedGenerationReconciler.#settleOne(mainTaskId);
                }
                catch (settleError)
                {
                    console.error(`[OrphanedGenerationReconciler] Failed to settle ${mainTaskId}: ${settleError.message}`);
                }
            }
        }
        finally
        {
            await TaskManager.releaseReconcileLock();
        }
    }

    /**
     * Settles a single orphaned run and clears its marker (so a repeat sweep
     * finds nothing).
     * @param {string} mainTaskId
     */
    static async #settleOne(mainTaskId)
    {
        const task = await TaskManager.getTask(mainTaskId);

        // The root blob already expired (5h TTL) — nothing left to settle, but
        // still clear the marker so the phantom finalization node can't linger.
        if (task === null)
        {
            await TaskManager.markPostPipelineDone(mainTaskId);
            console.log(`[OrphanedGenerationReconciler] ${mainTaskId}: root blob gone; cleared stale marker.`);
            return;
        }

        const userId = task.getUserId();

        // Distinguish a genuine mid-pipeline orphan from the razor-thin race
        // where moveToDatabase actually finished (and deleted the task folder)
        // but the process died in the few awaits before markPostPipelineDone.
        // moveToDatabase deletes the whole Tasks/{id}/ folder only as its very
        // last step, so surviving staged files mean the post-pipeline did NOT
        // complete. On any list error, assume the recoverable interpretation
        // (orphan) so a run is never silently lost.
        let bStagedOutputSurvives = true;
        try
        {
            const taskFiles = await Persistence.list(`${PersistenceConstants.TASKS_DIRECTORY}/${mainTaskId}/`);
            bStagedOutputSurvives = Array.isArray(taskFiles) && taskFiles.length > 0;
        }
        catch (listError)
        {
            console.warn(`[OrphanedGenerationReconciler] ${mainTaskId}: could not list staged output (${listError.message}); treating as orphaned.`);
        }

        if (!bStagedOutputSurvives)
        {
            // moveToDatabase had completed; only the marker/history/untrack tail
            // was skipped. The run SUCCEEDED — do not mark it failed. Archive it,
            // clear the phantom node, drop the stale start-saved resume snapshot,
            // and untrack. recordCompletion is an upsert, so a double is harmless.
            try { await TaskHistoryQueryEngine.recordCompletion(task); }
            catch (historyError) { console.error(`[OrphanedGenerationReconciler] ${mainTaskId}: failed to record taskHistory (completed path): ${historyError.message}`); }

            await TaskManager.markPostPipelineDone(mainTaskId);

            if (userId)
            {
                await OrphanedGenerationReconciler.#deleteResumeSnapshotIfOwnedBy(userId, mainTaskId);
                await TaskManager.untrackForUser(userId, mainTaskId);

                // The run finished (its tail was skipped by a crash) — the user
                // never got told. Notify now on every channel; email matters most
                // here, because a run that was orphaned by a restart is exactly
                // the case where nobody is still sitting on the progress page.
                // Never throws.
                try
                {
                    await NotificationDispatcher.dispatch(userId, NotificationContent.generationComplete(""), NotificationDispatcher.IN_APP_AND_PUSH_AND_EMAIL);
                }
                catch (notifyError)
                {
                    console.warn(`[OrphanedGenerationReconciler] ${mainTaskId}: failed to dispatch generation-complete notification: ${notifyError.message}`);
                }
            }

            console.log(`[OrphanedGenerationReconciler] ${mainTaskId}: post-pipeline had actually completed; cleared marker and archived as done.`);
            return;
        }

        // Genuine orphan: settle into the resumable state. A run that registered
        // post-pipeline image tasks is an image run (IMAGE_PREPARATION_FAILED
        // gives the "text ready — resume to finish images" wording); otherwise it
        // was orphaned mid-moveToDatabase, so the generic "interrupted" reason is
        // more accurate.
        const registeredPostPipelineTaskIds = await TaskManager.getPostPipelineTaskIds(mainTaskId);
        const resumableReason = registeredPostPipelineTaskIds.length > 0
            ? TaskManager.IMAGE_PREPARATION_FAILED_REASON
            : TaskManager.INTERRUPTED_REASON;

        const existingPayload = task.getPayload() || {};
        task.setStatus(taskStatus.FAILED);
        task.setPayload({ ...existingPayload, error: existingPayload.error || resumableReason });
        await TaskManager.updateTask(task);

        // Re-point the user's resumable snapshot at the settled reason so the
        // banner words itself correctly. Only when it belongs to THIS run — the
        // one-slot-per-user state may since have been overwritten by a newer,
        // unrelated pause. The start-saved snapshot already carries the
        // resumeMainTaskId + full payload, so we reuse them verbatim.
        if (userId)
        {
            try
            {
                const existingState = await TaskStateManager.load(userId);
                const statePayload = existingState ? (existingState.getPayload() || {}) : null;
                if (statePayload && statePayload.resumeMainTaskId === mainTaskId)
                {
                    await TaskStateManager.save({
                        userId: userId,
                        taskType: existingState.getTaskType(),
                        route: existingState.getRoute(),
                        payload: statePayload,
                        pausedReason: resumableReason,
                    });
                }
            }
            catch (stateError)
            {
                console.warn(`[OrphanedGenerationReconciler] ${mainTaskId}: could not update resumable snapshot: ${stateError.message}`);
            }
        }

        // Archive the settled state so Activity shows a terminal row instead of a
        // perpetual in-progress one.
        try { await TaskHistoryQueryEngine.recordCompletion(task); }
        catch (historyError) { console.error(`[OrphanedGenerationReconciler] ${mainTaskId}: failed to record taskHistory: ${historyError.message}`); }

        // Clear the marker + registered post-pipeline task ids (stops GetProgress
        // emitting the phantom finalization node) and drop the run from the
        // per-user active index.
        await TaskManager.markPostPipelineDone(mainTaskId);
        if (userId)
        {
            await TaskManager.untrackForUser(userId, mainTaskId);
        }

        console.log(`[OrphanedGenerationReconciler] Settled orphaned run ${mainTaskId} as resumable (${resumableReason}).`);
    }

    /**
     * Deletes the user's resumable snapshot only when it actually points at this
     * run, so a newer unrelated paused state (one slot per user) is never wiped.
     * @param {string} userId
     * @param {string} mainTaskId
     */
    static async #deleteResumeSnapshotIfOwnedBy(userId, mainTaskId)
    {
        try
        {
            const existingState = await TaskStateManager.load(userId);
            const statePayload = existingState ? (existingState.getPayload() || {}) : null;
            if (statePayload && statePayload.resumeMainTaskId === mainTaskId)
            {
                await TaskStateManager.delete(userId);
            }
        }
        catch (deleteError)
        {
            console.warn(`[OrphanedGenerationReconciler] ${mainTaskId}: could not clear resume snapshot: ${deleteError.message}`);
        }
    }
}

module.exports = OrphanedGenerationReconciler;
