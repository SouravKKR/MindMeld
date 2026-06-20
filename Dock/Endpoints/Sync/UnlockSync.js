const { PacketronRequest, PacketronResponse } = require("@gamiumgamers/packetron");
const { getUser } = require("../Helpers/GetUser");
const TaskManager = require("../../Globals/Classes/Task/TaskManager");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");

/**
 * Releases a sync lock for the authenticated user's device.
 * Only the device that acquired the lock can release it.
 *
 * Request body:
 *   { deviceId: string }
 *
 * Response body:
 *   { released: boolean }
 *
 * @param {PacketronRequest} request - The incoming request.
 * @param {PacketronResponse} response - The outgoing response.
 */
async function handleUnlockSync(request, response)
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

    const bReleased = await TaskManager.releaseSyncLock(user.getId(), deviceId);

    response.sendJson({ released: bReleased });
}

module.exports = { handleUnlockSync };