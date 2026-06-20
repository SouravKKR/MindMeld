const { PacketronPlugin } = require("@gamiumgamers/packetron");
const AuthenticationQueryEngine = require("../../Globals/Classes/Database/AuthenticationQueryEngine");
const LicenseConstants = require("../../Globals/Constants/LicenseConstants");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");

const ensureDeviceLimit = new PacketronPlugin
({
    handler: async (request, response) =>
    {
        const userId = request.body?.userId || request.pendingUserId;
        const deviceId = request.body?.deviceId || request.pendingDeviceId;

        if (!userId)
        {
            return false;
        }

        const existingDevices = await AuthenticationQueryEngine.listUserDevices(userId);
        const isKnownDevice = deviceId && existingDevices.some(device => device.getId() === deviceId);

        if (isKnownDevice)
        {
            return false;
        }

        const activeDeviceCount = await AuthenticationQueryEngine.countActiveDevices
        (
            userId,
            LicenseConstants.OFFLINE_GRACE_DAYS_FOR_DEVICE_SIGNOUT
        );

        if (activeDeviceCount >= LicenseConstants.MAX_DEVICES_PER_USER)
        {
            response.statusCode = httpStatus.CONFLICT;
            response.sendJson
            ({
                error: ErrorCodes.DEVICE_LIMIT_REACHED,
                maxDevices: LicenseConstants.MAX_DEVICES_PER_USER,
                devices: existingDevices.map(device => device.toJson())
            });
            return true;
        }

        return false;
    }
});

module.exports = { ensureDeviceLimit };
