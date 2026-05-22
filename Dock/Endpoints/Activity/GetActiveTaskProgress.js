const TaskManager = require("../../Globals/Classes/Task/TaskManager");


/**
 * GET /Activity/Tasks/Progress?taskid={id}
 *
 * Returns the recursive task tree (same shape as /Generate/Progress)
 * with an explicit ownership check — the requester must be the user
 * who originated the task. Without this guard, any logged-in user with
 * a known task id could read another user's progress + payload.
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

        const rootTask = await TaskManager.getTask(taskId);
        if (!rootTask)
        {
            response.sendStatusCode(404);
            return;
        }

        const ownerUserId = GetActiveTaskProgressEndpoint.#readUserId(rootTask);
        if (ownerUserId !== session.getUserId())
        {
            response.sendStatusCode(403);
            return;
        }

        const tree = await GetActiveTaskProgressEndpoint.#buildTaskTree(taskId);
        response.sendJson(tree);
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
            children: children
        };
    }
}

async function getActiveTaskProgress(request, response)
{
    await GetActiveTaskProgressEndpoint.handle(request, response);
}

module.exports = { getActiveTaskProgress };
