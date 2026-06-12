const { getUser } = require("../Helpers/GetUser");
const TaskStateManager = require("../../Globals/Classes/Task/TaskStateManager");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");

/**
 * GET /TaskState
 *
 * Returns the authenticated user's single resumable task state (route +
 * payload + taskType + pausedReason), or { taskState: null } when none
 * exists. The client re-submits payload to route to resume.
 */
async function getTaskState(request, response)
{
    const user = await getUser(request);

    if (!user)
    {
        response.sendStatusCode(httpStatus.UNAUTHORIZED);
        return;
    }

    const taskState = await TaskStateManager.load(user.getId());

    response.statusCode = httpStatus.OK;
    response.sendJson({ taskState: taskState ? taskState.toJson() : null });
}

module.exports = { getTaskState };
