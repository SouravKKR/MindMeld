const AuthenticationQueryEngine = require("../../Globals/Classes/Database/AuthenticationQueryEngine");
const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");
const LicenseConstants = require("../../Globals/Constants/LicenseConstants");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");


/**
 * GET /Auth/Devices
 *
 * Returns the user's device list with per-row annotations:
 *   - isCurrent          : matches the requester's session.deviceId
 *   - canSignOutRemotely : device hasn't been seen within the offline grace window
 *   - sessionCount       : number of distinct sessions currently bound to this device
 *
 * sessionCount surfaces the new many-browsers-per-device reality —
 * after PhysicalDeviceFingerprint rolls out, opening Chrome + Firefox
 * on the same laptop results in one Device row with two sessions,
 * and the dialog can show "2 active browser sessions" under the row.
 */
async function handleListDevices(request, response)
{
    const session = request.session;
    if (!session)
    {
        response.sendStatusCode(httpStatus.UNAUTHORIZED);
        return;
    }

    const userId = session.getUserId();
    const devices = await AuthenticationQueryEngine.listUserDevices(userId);
    const currentDeviceId = session.getDeviceId();
    const offlineCutoff = new Date(Date.now() - LicenseConstants.OFFLINE_GRACE_DAYS_FOR_DEVICE_SIGNOUT * 24 * 60 * 60 * 1000);

    const sessionsCollection = (await DatabaseConnector.getDatabase())
        .collection(DatabaseConstants.SESSIONS_COLLECTION);

    const deviceSummaries = [];
    for (let deviceIndex = 0; deviceIndex < devices.length; deviceIndex++)
    {
        const device = devices[deviceIndex];
        const json = device.toJson();
        json.isCurrent = device.getId() === currentDeviceId;
        json.canSignOutRemotely = device.getLastSeenDate() < offlineCutoff;
        json.sessionCount = await sessionsCollection.countDocuments({ userId: userId, deviceId: device.getId() });
        deviceSummaries.push(json);
    }

    response.statusCode = httpStatus.OK;
    response.sendJson
    ({
        devices: deviceSummaries,
        maxDevices: LicenseConstants.MAX_DEVICES_PER_USER,
        offlineGraceDays: LicenseConstants.OFFLINE_GRACE_DAYS_FOR_DEVICE_SIGNOUT
    });
}

module.exports = { handleListDevices };
