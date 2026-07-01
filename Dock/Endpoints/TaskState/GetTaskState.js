const { getUser } = require("../Helpers/GetUser");
const TaskStateManager = require("../../Globals/Classes/Task/TaskStateManager");
const { isGenerationRunning } = require("../AutomaticGeneration/Generate");
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
    const taskStateJson = taskState ? taskState.toJson() : null;

    // A generation saves a resumable snapshot at START so a restart-orphaned run
    // can be recovered — but while THIS process is still driving the run it must
    // not be presented as "interrupted". Flag a live run so the client's
    // PausedTaskBanner suppresses the resume prompt (the user watches it from
    // Activity instead). False after a restart, so a truly orphaned run still
    // surfaces for resume.
    if (taskStateJson)
    {
        const resumeMainTaskId = (taskStateJson.payload && taskStateJson.payload.resumeMainTaskId) || null;
        taskStateJson.isStillRunning = isGenerationRunning(resumeMainTaskId);
    }

    response.statusCode = httpStatus.OK;
    response.sendJson({ taskState: taskStateJson });
}

module.exports = { getTaskState };
