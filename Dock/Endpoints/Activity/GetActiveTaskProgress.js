const TaskManager = require("../../Globals/Classes/Task/TaskManager");
const TaskHistoryQueryEngine = require("../../Globals/Classes/Database/TaskHistoryQueryEngine");
const { taskStatus } = require("../../Globals/Enumerations/TaskStatus");


/**
 * GET /Activity/Tasks/Progress?taskid={id}
 *
 * Returns one of two payload shapes for the same task id:
 *
 *   1. Live tree (task still in Redis) — recursive
 *      { id, type, status, completion, parentTaskId, children: [...] }
 *      Same shape as /Generate/Progress; the frontend polls until the
 *      root status is terminal.
 *
 *   2. Historical record (task has rolled off Redis into the long-term
 *      taskHistory collection) — flat
 *      { historical: true, id, type, status, completion,
 *        completedAt, startDate, durationMillis, payloadSummary,
 *        additionalData, parentTaskId }
 *      The frontend renders a "completed" view with metadata and does
 *      NOT poll. Without this fallback, clicking "View" on a finished
 *      Activity entry produced a 500 because BSON.deserialize choked on
 *      the missing Redis blob.
 *
 * Both branches enforce that the requester owns the task before any
 * payload is returned.
 */
class GetActiveTaskProgressEndpoint
{
    static async handle(request, response)
    {
        const session = request.session;
        if (!session)
        {
            response.sendStatusCode(401);
            return;
        }

        const params = await request.getQueryParams();
        const taskId = params["taskid"];

        if (!taskId)
        {
            response.sendStatusCode(400);
            return;
        }

        const userId = session.getUserId();

        const rootTask = await TaskManager.getTask(taskId);
        if (rootTask)
        {
            const ownerUserId = GetActiveTaskProgressEndpoint.#readUserId(rootTask);
            if (ownerUserId !== userId)
            {
                response.sendStatusCode(403);
                return;
            }

            const tree = await GetActiveTaskProgressEndpoint.#buildTaskTree(taskId);
            // Flag a mid-pipeline out-of-credits stop so the client can offer
            // the top-up / resume flow instead of a generic failure.
            tree.outOfCredits = GetActiveTaskProgressEndpoint.#treeHasInsufficientCredits(tree);
            response.sendJson(tree);
            return;
        }

        // Live descriptor has expired from Redis. The task either
        // finished and was archived to taskHistory, or it never existed.
        const historyRow = await TaskHistoryQueryEngine.getByIdForUser(taskId, userId);
        if (!historyRow)
        {
            response.sendStatusCode(404);
            return;
        }

        response.sendJson(GetActiveTaskProgressEndpoint.#buildHistoricalPayload(historyRow));
    }

    static #readUserId(taskDescriptor)
    {
        if (typeof taskDescriptor.getUserId === "function")
        {
            return taskDescriptor.getUserId() || "";
        }
        const json = typeof taskDescriptor.toJson === "function" ? taskDescriptor.toJson() : null;
        return (json && typeof json === "object" && typeof json.userId === "string") ? json.userId : "";
    }

    static async #buildTaskTree(taskId)
    {
        const task = await TaskManager.getTask(taskId);
        if (!task)
        {
            return null;
        }

        const nextTaskIds = task.getNextTaskIds() || [];
        const children = (await Promise.all(nextTaskIds.map((id) => GetActiveTaskProgressEndpoint.#buildTaskTree(id))))
            .filter(Boolean);

        return {
            id: task.getId(),
            type: task.getType(),
            status: task.getStatus(),
            completion: typeof task.getCompletion === "function" ? task.getCompletion() : 0,
            parentTaskId: task.getParentTaskId() || null,
            // Failure reason so the client can detect an out-of-credits stop.
            error: (typeof task.getPayload === "function" ? task.getPayload()?.error : null) || null,
            children: children
        };
    }

    static #treeHasInsufficientCredits(treeNode)
    {
        if (!treeNode)
        {
            return false;
        }
        if (treeNode.status === taskStatus.FAILED && treeNode.error === TaskManager.INSUFFICIENT_CREDITS_REASON)
        {
            return true;
        }
        for (const childNode of (treeNode.children || []))
        {
            if (GetActiveTaskProgressEndpoint.#treeHasInsufficientCredits(childNode))
            {
                return true;
            }
        }
        return false;
    }

    static #buildHistoricalPayload(historyRow)
    {
        const completedAtIso = historyRow.completedAt instanceof Date
            ? historyRow.completedAt.toISOString()
            : (historyRow.completedAt || null);
        const startDateIso = historyRow.startDate instanceof Date
            ? historyRow.startDate.toISOString()
            : (historyRow.startDate || null);

        return {
            historical: true,
            id: historyRow.id,
            type: historyRow.type,
            status: historyRow.status,
            completion: typeof historyRow.completion === "number" ? historyRow.completion : 0,
            completedAt: completedAtIso,
            startDate: startDateIso,
            durationMillis: typeof historyRow.durationMillis === "number" ? historyRow.durationMillis : 0,
            payloadSummary: historyRow.payloadSummary || "",
            parentTaskId: historyRow.parentTaskId || null,
            additionalData: (historyRow.additionalData && typeof historyRow.additionalData === "object")
                ? historyRow.additionalData
                : {}
        };
    }
}

async function getActiveTaskProgress(request, response)
{
    await GetActiveTaskProgressEndpoint.handle(request, response);
}

module.exports = { getActiveTaskProgress };
