const { getUser } = require("../Helpers/GetUser");
const NotificationQueryEngine = require("../../Globals/Classes/Database/NotificationQueryEngine");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");

/**
 * POST /Notifications/MarkRead
 * Body: { notificationId: string }
 *
 * Marks one of the caller's in-app notifications read. Scoped to the
 * authenticated user so a client can never mark another user's notification.
 */
async function markNotificationRead(request, response)
{
    const user = await getUser(request);
    if (!user)
    {
        response.statusCode = httpStatus.UNAUTHORIZED;
        response.sendJson({ error: ErrorCodes.INVALID_REQUEST });
        return;
    }

    const body = await request.getBody();
    const notificationId = typeof body?.notificationId === "string" ? body.notificationId.trim() : "";
    if (!notificationId)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_REQUEST });
        return;
    }

    const result = await NotificationQueryEngine.markRead(user.getId(), notificationId);
    if (!result.updated)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ error: ErrorCodes.NOTIFICATION_NOT_FOUND });
        return;
    }

    response.statusCode = httpStatus.OK;
    response.sendJson({ success: true });
}

module.exports = { markNotificationRead };
