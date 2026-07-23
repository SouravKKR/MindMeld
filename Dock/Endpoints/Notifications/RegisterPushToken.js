const { getUser } = require("../Helpers/GetUser");
const PushTokenQueryEngine = require("../../Globals/Classes/Database/PushTokenQueryEngine");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");
const { devicePlatforms } = require("../../Globals/Enumerations/DevicePlatforms");

/**
 * POST /Notifications/RegisterPushToken
 * Body: { token: string, platform?: number }
 *
 * Stores (or refreshes) the caller's FCM registration token so the backend can
 * push to this device. Idempotent — re-registering the same token just bumps
 * its lastSeenAt. The userId is taken from the authenticated session, never the
 * body.
 */
async function registerPushToken(request, response)
{
    const user = await getUser(request);
    if (!user)
    {
        response.statusCode = httpStatus.UNAUTHORIZED;
        response.sendJson({ error: ErrorCodes.INVALID_REQUEST });
        return;
    }

    const body = await request.getBody();
    const token = typeof body?.token === "string" ? body.token.trim() : "";
    if (!token || token.length > 4096)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.PUSH_TOKEN_REQUIRED });
        return;
    }

    const parsedPlatform = Number(body?.platform);
    const platform = Object.values(devicePlatforms).includes(parsedPlatform) ? parsedPlatform : devicePlatforms.UNKNOWN;

    const result = await PushTokenQueryEngine.registerToken(user.getId(), token, platform);

    response.statusCode = httpStatus.OK;
    response.sendJson({ success: true, registered: result.registered });
}

module.exports = { registerPushToken };
