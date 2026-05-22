const AuthenticationQueryEngine = require("../../Globals/Classes/Database/AuthenticationQueryEngine");
const LicenseConstants = require("../../Globals/Constants/LicenseConstants");
const DeviceLimitReachedError = require("../../Globals/Classes/Database/DeviceLimitReachedError");


/**
 * POST /Auth/Devices/Register
 *
 * Couples the current session to a Device row, with cross-browser
 * physical-device consolidation: same fingerprintHash from a different
 * browser merges onto the same Device. The 4-device limit is now
 * enforced inside AuthenticationQueryEngine.resolveOrCreateDevice
 * (which throws DeviceLimitReachedError when full) — this handler
 * just translates the error to a 409 response with the device list.
 *
 * Body:
 *   - fingerprintHash:      SHA-256 from PhysicalDeviceFingerprint
 *   - legacyDeviceId:       per-browser UUID from the old client (migration)
 *   - deviceId:             accepted as a synonym of legacyDeviceId so
 *                           older clients that still send the old key
 *                           keep working through the rollout window
 *   - deviceName:           "Chrome", "Safari", etc.
 *   - platform:             devicePlatforms enum value
 *   - userAgent:            navigator.userAgent (capped at 1024)
 *   - publicKeyFingerprint: KEK-derived per-browser hex string
 */
async function handleRegisterDevice(request, response)
{
    const session = request.session;
    if (!session)
    {
        response.sendStatusCode(401);
        return;
    }

    const body = await request.getBody();
    const userId = session.getUserId();

    const registrationPayload =
    {
        fingerprintHash: body?.fingerprintHash || "",
        legacyDeviceId: body?.legacyDeviceId || body?.deviceId || session.getDeviceId() || "",
        deviceName: body?.deviceName || "",
        platform: body?.platform,
        userAgent: body?.userAgent || "",
        publicKeyFingerprint: body?.publicKeyFingerprint || ""
    };

    let device;
    try
    {
        device = await AuthenticationQueryEngine.resolveOrCreateDevice(userId, registrationPayload);
    }
    catch (resolveError)
    {
        if (resolveError instanceof DeviceLimitReachedError)
        {
            response.statusCode = 409;
            response.sendJson
            ({
                error: "DEVICE_LIMIT_REACHED",
                maxDevices: LicenseConstants.MAX_DEVICES_PER_USER,
                devices: resolveError.getDevices()
            });
            return;
        }
        throw resolveError;
    }

    session.setDeviceId(device.getId());
    await AuthenticationQueryEngine.refreshSession(session);

    response.statusCode = 200;
    response.sendJson({ device: device.toJson() });
}

module.exports = { handleRegisterDevice };
