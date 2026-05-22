const { PacketronRequest, PacketronResponse } = require("@gamiumgamers/packetron");
const { getUser } = require("../Helpers/GetUser");
const TaskManager = require("../../Globals/Classes/Task/TaskManager");

/**
 * Force-releases the sync lock for the authenticated user, regardless of
 * which device currently holds it. Used by the client when a previous
 * sync cycle crashed mid-flight (closed tab, crashed Node process before
 * TTL expiry, lost connection mid-push) and the user is now blocked from
 * syncing on the SAME account from a different or returning device.
 *
 * This is safe because the lock is scoped to the authenticated user —
 * a force-unlock can never affect another user's syncing.
 *
 * Request body:
 *   { }
 *
 * Response body:
 *   { released: boolean, previousHolderDeviceId: string|null }
 *
 * @param {PacketronRequest} request
 * @param {PacketronResponse} response
 */
async function handleForceUnlockSync(request, response)
{
    const user = await getUser(request);

    if (!user)
    {
        response.sendStatusCode(401);
        return;
    }

    const userId         = user.getId();
    const previousState  = await TaskManager.getSyncLockState(userId);
    const bReleased      = await TaskManager.forceReleaseSyncLock(userId);

    console.warn(`[Sync/ForceUnlock] user=${userId} previousHolder=${previousState.holderDeviceId} released=${bReleased}`);

    response.sendJson(
    {
        released:               bReleased,
        previousHolderDeviceId: previousState.holderDeviceId
    });
}

module.exports = { handleForceUnlockSync };
