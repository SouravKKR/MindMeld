const { PacketronRequestMethod, PacketronHandlerFlags } = require("@gamiumgamers/packetron");
const { registerPushToken } = require("./Notifications/RegisterPushToken");
const { unregisterPushToken } = require("./Notifications/UnregisterPushToken");
const { listNotifications } = require("./Notifications/ListNotifications");
const { markNotificationRead } = require("./Notifications/MarkNotificationRead");
const { ensureLogin } = require("./Plugins/EnsureLogin");
const { httpStatus } = require("../Globals/Enumerations/HttpStatus");

/**
 * Registers the push-token + in-app-notification endpoints. All are
 * login-gated. Token registration and mark-read take a JSON body; the feed is
 * a GET. Routes are flat (no path params) per the packetron convention — ids
 * travel in the body / query string.
 */
function handleNotificationEndpoints(server)
{
    function wrapHandler(handlerFunction)
    {
        return async (request, response) =>
        {
            try
            {
                await handlerFunction(request, response);
            }
            catch (handlerError)
            {
                console.error(`Error in route: ${request.url}`);
                console.error(handlerError);
                response.sendStatusCode(httpStatus.INTERNAL_SERVER_ERROR);
            }
        };
    }

    server.handle
    ({
        routePath: `/Notifications/RegisterPushToken`,
        handler: wrapHandler(registerPushToken),
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureLogin]
    });

    server.handle
    ({
        routePath: `/Notifications/UnregisterPushToken`,
        handler: wrapHandler(unregisterPushToken),
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureLogin]
    });

    server.handle
    ({
        routePath: `/Notifications/List`,
        handler: wrapHandler(listNotifications),
        method: PacketronRequestMethod.GET,
        plugins: [ensureLogin]
    });

    server.handle
    ({
        routePath: `/Notifications/MarkRead`,
        handler: wrapHandler(markNotificationRead),
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureLogin]
    });
}

module.exports = { handleNotificationEndpoints };
