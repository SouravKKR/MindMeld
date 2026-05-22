const { getUser } = require("../Helpers/GetUser");
const TaskManager = require("../../Globals/Classes/Task/TaskManager");

/**
 * Recursively fetches a task and all its descendants from Redis,
 * building a nested tree for the client to render.
 * @param {string} taskId
 * @returns {Promise<object|null>}
 */
async function buildTaskTree(taskId)
{
    const task = await TaskManager.getTask(taskId);

    if (!task)
    {
        return null;
    }

    const nextTaskIds = task.getNextTaskIds() || [];

    const children = (await Promise.all(nextTaskIds.map(id => buildTaskTree(id)))).filter(Boolean);

    return {
        id: task.getId(),
        type: task.getType(),
        status: task.getStatus(),
        completion: task.getCompletion(),
        parentTaskId: task.getParentTaskId() || null,
        children
    };
}

async function handleGetProgress(request, response)
{
    const user = await getUser(request);

    if (!user)
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

    const tree = await buildTaskTree(taskId);

    if (!tree)
    {
        response.sendStatusCode(404);
        return;
    }

    response.sendJson(tree);
}

module.exports = { handleGetProgress };