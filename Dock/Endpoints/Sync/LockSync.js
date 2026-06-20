const { PacketronRequest, PacketronResponse } = require("@gamiumgamers/packetron");
const { getUser } = require("../Helpers/GetUser");
const TaskManager = require("../../Globals/Classes/Task/TaskManager");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");

/**
 * Acquires a sync lock for the authenticated user's device.
 * Prevents multiple devices from syncing simultaneously for the same user.
 *
 * Request body:
 *   { deviceId: string }
 *
 * Response body:
 *   { acquired: boolean }
 *
 * @param {PacketronRequest} request - The incoming request.
 * @param {PacketronResponse} response - The outgoing response.
 */
async function handleLockSync(request, response)
{
    const user = await getUser(request);
    
    if (!user)
    {
        response.sendStatusCode(httpStatus.UNAUTHORIZED);
        return;
    }

    const body = await request.getBody();
    const deviceId = body.deviceId;

    if (!deviceId)
    {
        response.sendStatusCode(httpStatus.BAD_REQUEST);
        return;
    }

    const bAcquired = await TaskManager.acquireSyncLock(user.getId(), deviceId);

    response.sendJson({ acquired: bAcquired });
}

module.exports = { handleLockSync };