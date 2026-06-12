const { getUser } = require("../Helpers/GetUser");
const TaskStateManager = require("../../Globals/Classes/Task/TaskStateManager");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");

/**
 * POST /TaskState/Discard
 *
 * Deletes the authenticated user's resumable task state (Mongo index doc +
 * bucket content). Idempotent — succeeds even when no state exists.
 */
async function discardTaskState(request, response)
{
    const user = await getUser(request);

    if (!user)
    {
        response.sendStatusCode(httpStatus.UNAUTHORIZED);
        return;
    }

    await TaskStateManager.delete(user.getId());

    response.statusCode = httpStatus.OK;
    response.sendJson({ ok: true });
}

module.exports = { discardTaskState };
