// Thin client for the resumable task-state feature. The server stores at most
// one paused task per user (e.g. saved when a run is blocked for credits);
// resuming simply re-submits the original request to its original route, which
// the server clears on success.
class TaskStateClient
{
    /**
     * Returns the user's paused task state ({ route, payload, taskType,
     * pausedReason, ... }) or null when none exists.
     */
    static async fetch()
    {
        try
        {
            const response = await fetch("/TaskState", { credentials: "same-origin" });
            if (!response.ok)
            {
                return null;
            }
            const body = await response.json();
            return body.taskState || null;
        }
        catch (fetchError)
        {
            return null;
        }
    }

    /**
     * Re-submits the original request that was paused. Returns the raw
     * Response so the caller can branch on status (e.g. 402 if still short on
     * credits). A successful re-submit clears the state server-side.
     * @param {{ route: string, payload: object }} taskState
     * @returns {Promise<Response>}
     */
    static async resume(taskState)
    {
        return await fetch(taskState.route,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify(taskState.payload || {}),
        });
    }

    /**
     * Discards the paused state without resuming.
     */
    static async discard()
    {
        try
        {
            await fetch("/TaskState/Discard", { method: "POST", credentials: "same-origin" });
        }
        catch (discardError)
        {
            // Best-effort; the state will TTL-expire regardless.
        }
    }
}

export default TaskStateClient;
