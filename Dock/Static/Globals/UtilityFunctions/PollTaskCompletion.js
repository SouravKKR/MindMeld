import { taskStatus } from "../Enumerations/TaskStatus.js";


/**
 * Polls /Generate/Progress?taskid=<taskId> at a steady interval until the
 * task reaches a terminal state (COMPLETED or FAILED) or the timeout fires.
 *
 * Designed to be reusable for any flow that hands off a long-running Agent
 * task and wants the client to track its completion (e.g. OCR upload phase,
 * future inline mock-test regeneration, etc.).
 *
 *   pollTaskCompletion(taskId, (completion, taskTree) => { ... },
 *                      { intervalMs, timeoutMs })
 *     → Promise<{ status: number, completion: number, taskTree: object }>
 *
 * Resolves on COMPLETED. Rejects on FAILED, timeout, or a 404 (task gone).
 * onProgress is invoked on every successful poll with the latest values.
 */
async function pollTaskCompletion(taskId, onProgress, options = {})
{
    const intervalMs = typeof options.intervalMs === "number" ? options.intervalMs : 1000;
    const timeoutMs = typeof options.timeoutMs === "number" ? options.timeoutMs : 600000;

    const startTimestamp = Date.now();

    return new Promise((resolve, reject) =>
    {
        const pollOnce = async () =>
        {
            if (Date.now() - startTimestamp > timeoutMs)
            {
                reject(new Error(`Task ${taskId} polling timed out after ${timeoutMs}ms`));
                return;
            }

            let response;
            try
            {
                response = await fetch(`/Generate/Progress?taskid=${encodeURIComponent(taskId)}`);
            }
            catch (networkError)
            {
                // Transient network blip — try again on the next tick.
                console.warn(`[PollTaskCompletion] Network error: ${networkError.message}`);
                setTimeout(pollOnce, intervalMs);
                return;
            }

            if (response.status === 404)
            {
                reject(new Error(`Task ${taskId} not found`));
                return;
            }

            if (!response.ok)
            {
                console.warn(`[PollTaskCompletion] Poll returned ${response.status}`);
                setTimeout(pollOnce, intervalMs);
                return;
            }

            let taskTree;
            try
            {
                taskTree = await response.json();
            }
            catch (parseError)
            {
                console.warn(`[PollTaskCompletion] Failed to parse poll response: ${parseError.message}`);
                setTimeout(pollOnce, intervalMs);
                return;
            }

            const completion = typeof taskTree?.completion === "number" ? taskTree.completion : 0;
            const status = typeof taskTree?.status === "number" ? taskTree.status : taskStatus.UNKNOWN;

            if (typeof onProgress === "function")
            {
                try
                {
                    onProgress(completion, taskTree);
                }
                catch (progressCallbackError)
                {
                    console.warn(`[PollTaskCompletion] onProgress callback threw: ${progressCallbackError.message}`);
                }
            }

            if (status === taskStatus.COMPLETED)
            {
                resolve({ status, completion, taskTree });
                return;
            }

            if (status === taskStatus.FAILED)
            {
                reject(new Error(`Task ${taskId} failed`));
                return;
            }

            setTimeout(pollOnce, intervalMs);
        };

        pollOnce();
    });
}

export { pollTaskCompletion };
