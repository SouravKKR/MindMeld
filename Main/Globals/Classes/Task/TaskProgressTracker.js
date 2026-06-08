import SyncEvents from "../../Events/SyncEvents.js";
import SyncOrchestrator from "../Syncing/SyncOrchestrator.js";
import { taskStatus } from "../../Enumerations/TaskStatus.js";


/**
 * TaskProgressTracker
 *
 * Generic client-side waiter for any LOCAL Agent task that surfaces
 * progress through the standard /Generate/Progress endpoint. Polls
 * every POLL_INTERVAL_MILLISECONDS until the entire task tree reaches
 * a terminal status (COMPLETED or FAILED across every descendant),
 * then optionally triggers a sync so the post-task server writes
 * reach the local model.
 *
 * Originally lifted out of AnalysisTaskRunner so the curated-study
 * wait flow and the mock-test evaluation wait flow can share one
 * implementation instead of growing two copies. AnalysisTaskRunner
 * still owns the analysis-specific orchestration (queue request,
 * `bClearPreviousFirst`, etc.) and now delegates its polling +
 * sync-trigger to this tracker.
 *
 * Phase events the tracker emits via `onStatusChange({phase, ...})`:
 *   - "progress"        — task tree polled, includes taskTree
 *   - "task-terminal"   — every node in the tree is COMPLETED or FAILED
 *   - "sync-complete"   — post-task sync cycle finished
 *
 * The phase names match what CuratedStudyProgressOverlay's
 * `#labelForPhase` already understands, so callers can pipe events
 * straight through without translation.
 */
class TaskProgressTracker
{
    static POLL_INTERVAL_MILLISECONDS = 2000;
    static MAX_POLL_DURATION_MILLISECONDS = 5 * 60 * 1000;
    static PROGRESS_ENDPOINT = "/Generate/Progress";

    /**
     * Polls /Generate/Progress for `taskId` until the whole tree is
     * terminal (or the max-duration safety cap fires). Resolves with
     * the final task tree. Emits `phase: "progress"` on every poll.
     */
    static async pollUntilTerminal(taskId, onStatusChange = null)
    {
        const startTimestampMilliseconds = Date.now();

        return new Promise((resolve, reject) =>
        {
            let intervalHandle = null;

            const cleanupAndResolve = (terminalTaskTree) =>
            {
                if (intervalHandle !== null)
                {
                    clearInterval(intervalHandle);
                    intervalHandle = null;
                }
                resolve(terminalTaskTree);
            };

            const cleanupAndReject = (pollError) =>
            {
                if (intervalHandle !== null)
                {
                    clearInterval(intervalHandle);
                    intervalHandle = null;
                }
                reject(pollError);
            };

            const pollOnce = async () =>
            {
                try
                {
                    if (Date.now() - startTimestampMilliseconds > TaskProgressTracker.MAX_POLL_DURATION_MILLISECONDS)
                    {
                        cleanupAndReject(new Error("Task timed out — server never reported a terminal status."));
                        return;
                    }

                    const progressResponse = await fetch(`${TaskProgressTracker.PROGRESS_ENDPOINT}?taskid=${encodeURIComponent(taskId)}`,
                    {
                        method: "GET",
                        credentials: "same-origin",
                    });
                    if (!progressResponse.ok)
                    {
                        const responseText = await progressResponse.text().catch(() => "");
                        cleanupAndReject(new Error(`${TaskProgressTracker.PROGRESS_ENDPOINT} returned ${progressResponse.status}: ${responseText}`));
                        return;
                    }
                    const taskTree = await progressResponse.json();

                    if (typeof onStatusChange === "function")
                    {
                        onStatusChange({ phase: "progress", taskTree: taskTree });
                    }

                    if (TaskProgressTracker.#isTreeTerminal(taskTree))
                    {
                        cleanupAndResolve(taskTree);
                    }
                }
                catch (pollError)
                {
                    cleanupAndReject(pollError);
                }
            };

            // Fire one immediate poll so the caller sees `progress`
            // before the first 2-second interval, then settle into
            // the steady polling cadence.
            pollOnce();
            intervalHandle = setInterval(pollOnce, TaskProgressTracker.POLL_INTERVAL_MILLISECONDS);
        });
    }

    /**
     * Force-triggers a sync cycle and resolves once SyncEvents.COMPLETED
     * fires (rejects on SyncEvents.FAILED). Uses the same wait pattern
     * AnalysisTaskRunner originally used.
     */
    static async triggerSync()
    {
        return new Promise((resolve, reject) =>
        {
            const onCompleted = () =>
            {
                window.removeEventListener(SyncEvents.COMPLETED, onCompleted);
                window.removeEventListener(SyncEvents.FAILED, onFailed);
                resolve();
            };
            const onFailed = (failedEvent) =>
            {
                window.removeEventListener(SyncEvents.COMPLETED, onCompleted);
                window.removeEventListener(SyncEvents.FAILED, onFailed);
                const failureReason = failedEvent?.detail?.error || new Error("Sync failed.");
                reject(failureReason);
            };
            window.addEventListener(SyncEvents.COMPLETED, onCompleted);
            window.addEventListener(SyncEvents.FAILED, onFailed);

            SyncOrchestrator.sync({ bForce: true }).catch((triggerError) =>
            {
                window.removeEventListener(SyncEvents.COMPLETED, onCompleted);
                window.removeEventListener(SyncEvents.FAILED, onFailed);
                reject(triggerError);
            });
        });
    }

    /**
     * Convenience wrapper: poll until terminal, then trigger a sync if
     * the task ended in COMPLETED status, then resolve with the final
     * task tree + terminal status. Emits "task-terminal" and (on
     * success) "sync-complete" phase events along the way so a hooked
     * progress overlay can update its label.
     */
    static async trackAndSync(taskId, onStatusChange = null)
    {
        const finalTaskTree = await TaskProgressTracker.pollUntilTerminal(taskId, onStatusChange);
        const finalStatus = (finalTaskTree && typeof finalTaskTree.status === "number") ? finalTaskTree.status : taskStatus.UNKNOWN;

        if (typeof onStatusChange === "function")
        {
            onStatusChange({ phase: "task-terminal", taskTree: finalTaskTree, status: finalStatus });
        }

        if (finalStatus === taskStatus.COMPLETED)
        {
            await TaskProgressTracker.triggerSync();
            if (typeof onStatusChange === "function")
            {
                onStatusChange({ phase: "sync-complete" });
            }
        }

        return { taskTree: finalTaskTree, status: finalStatus };
    }

    /**
     * A tree is terminal only when its root AND every descendant is in
     * COMPLETED or FAILED. Used by the polling loop so the resolve fires
     * after the entire fan-out lands, not just the orchestrator parent.
     * (ANALYZE_DECK_PERFORMANCE for example flips its own completion to
     * 1.0 the moment it spawns GENERATE_CURATED_STUDY_MATERIAL children;
     * reading only the root would resolve far too early.)
     */
    static #isTreeTerminal(node)
    {
        if (!node)
        {
            return true;
        }
        const nodeStatus = typeof node.status === "number" ? node.status : taskStatus.UNKNOWN;
        if (nodeStatus !== taskStatus.COMPLETED && nodeStatus !== taskStatus.FAILED)
        {
            return false;
        }
        const children = Array.isArray(node.children) ? node.children : [];
        for (const childNode of children)
        {
            if (!TaskProgressTracker.#isTreeTerminal(childNode))
            {
                return false;
            }
        }
        return true;
    }
}

export default TaskProgressTracker;
