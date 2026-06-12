const { PacketronRequestMethod } = require("@gamiumgamers/packetron");
const { getTaskState } = require("./TaskState/GetTaskState");
const { discardTaskState } = require("./TaskState/DiscardTaskState");
const { ensureLogin } = require("./Plugins/EnsureLogin");

function handleTaskStateEndpoints(server)
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
                response.sendStatusCode(500);
            }
        };
    }

    server.handle
    ({
        routePath: `/TaskState`,
        handler: wrapHandler(getTaskState),
        method: PacketronRequestMethod.GET,
        plugins: [ensureLogin]
    });

    server.handle
    ({
        routePath: `/TaskState/Discard`,
        handler: wrapHandler(discardTaskState),
        method: PacketronRequestMethod.POST,
        plugins: [ensureLogin]
    });
}

module.exports = { handleTaskStateEndpoints };
