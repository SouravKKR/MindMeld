const { getUser } = require("../Helpers/GetUser");
const NotificationQueryEngine = require("../../Globals/Classes/Database/NotificationQueryEngine");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");

/**
 * GET /Notifications/List?limit=50
 *
 * Returns the caller's in-app notifications, newest first. The client uses this
 * for the notification feed and to count unread items (readAt === null).
 */
async function listNotifications(request, response)
{
    const user = await getUser(request);
    if (!user)
    {
        response.statusCode = httpStatus.UNAUTHORIZED;
        response.sendJson({ error: ErrorCodes.INVALID_REQUEST });
        return;
    }

    const queryParams = await request.getQueryParams();
    const parsedLimit = Number(queryParams?.limit);
    const limit = Number.isInteger(parsedLimit) && parsedLimit > 0 ? parsedLimit : 50;

    const notifications = await NotificationQueryEngine.listForUser(user.getId(), limit);
    const unreadCount = notifications.filter(notification => notification.readAt === null).length;

    response.statusCode = httpStatus.OK;
    response.sendJson({ success: true, notifications: notifications, unreadCount: unreadCount });
}

module.exports = { listNotifications };
