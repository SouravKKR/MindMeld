const { PacketronRequestMethod } = require("@gamiumgamers/packetron");
const { clearUserData } = require("./Profile/ClearUserData");
const { ensureLogin } = require("./Plugins/EnsureLogin");

function handleProfileEndpoints(server)
{
    function wrapHandler(handlerFunction)
    {
        return async (request, response) =>
        {
            try
            {
                await handlerFunction(request, response);
            }
            catch(handlerError)
            {
                console.error(`Error in route: ${request.url}`);
                console.error(handlerError);
                response.sendStatusCode(500);
            }
        };
    }

    server.handle
    ({
        routePath: `/Profile/ClearUserData`,
        handler: wrapHandler(clearUserData),
        method: PacketronRequestMethod.POST,
        plugins: [ensureLogin]
    });
}

module.exports = { handleProfileEndpoints };
