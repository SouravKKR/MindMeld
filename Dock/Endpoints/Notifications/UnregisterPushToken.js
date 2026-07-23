const { getUser } = require("../Helpers/GetUser");
const PushTokenQueryEngine = require("../../Globals/Classes/Database/PushTokenQueryEngine");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");

/**
 * POST /Notifications/UnregisterPushToken
 * Body: { token: string }
 *
 * Removes one of the caller's device tokens (e.g. on logout, or when the client
 * detects the token rotated). Scoped to the authenticated user so a client can
 * only delete its own tokens.
 */
async function unregisterPushToken(request, response)
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
    if (!token)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.PUSH_TOKEN_REQUIRED });
        return;
    }

    const result = await PushTokenQueryEngine.removeToken(user.getId(), token);

    response.statusCode = httpStatus.OK;
    response.sendJson({ success: true, removed: result.removed });
}

module.exports = { unregisterPushToken };
