const { getUser } = require("../Helpers/GetUser");
const TaskManager = require("../../Globals/Classes/Task/TaskManager");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");

/**
 * POST /Generate/Pause   body: { taskId }
 *
 * Flags a running generation as paused. The pause takes effect at the next
 * stage boundary — a task already running finishes, then no further tasks
 * launch (see TaskManager.execute's pause gate). The Generate pipeline's
 * completion handler then saves a resumable snapshot so the user can continue
 * later from the home-screen banner.
 *
 * Only the owner of the task may pause it.
 */
async function handlePauseGeneration(request, response)
{
    const user = await getUser(request);

    if (!user)
    {
        response.sendStatusCode(httpStatus.UNAUTHORIZED);
        return;
    }

    const body = await request.getBody();
    const taskId = body ? body["taskId"] : null;

    if (!taskId)
    {
        response.sendStatusCode(httpStatus.BAD_REQUEST);
        return;
    }

    // Ownership check: a user may only pause their own generation. A missing
    // task (expired from Redis or never existed) is a 404 rather than a silent
    // success so the client can stop showing "Pausing…".
    const task = await TaskManager.getTask(taskId);

    if (!task)
    {
        response.sendStatusCode(httpStatus.NOT_FOUND);
        return;
    }

    if (task.getUserId() !== user.getId())
    {
        response.sendStatusCode(httpStatus.FORBIDDEN);
        return;
    }

    await TaskManager.markPaused(taskId);

    response.statusCode = httpStatus.OK;
    response.sendJson({ paused: true });
}

module.exports = { handlePauseGeneration };
