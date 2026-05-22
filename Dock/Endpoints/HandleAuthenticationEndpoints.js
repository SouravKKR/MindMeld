const authenticationProviders = require("../Globals/Enumerations/AuthenticationProviders");
const { Packetron, PacketronHandlerFlags, PacketronPlugin, PacketronRequestMethod } = require("@gamiumgamers/packetron");
const { handleLogin } = require("./Authentication/HandleLogin");
const { handleLoginCallback } = require("./Authentication/HandleLoginCallback");
const { handleGetUser } = require("./Authentication/HandleGetUser");
const { handleLogout } = require("./Authentication/HandleLogout");
const { handleUpdateUserAdditionalData } = require("./Authentication/HandleUpdateUserAdditionalData");
const { handleListDevices } = require("./Authentication/HandleListDevices");
const { handleSignOutDevice } = require("./Authentication/HandleSignOutDevice");
const { handleDeviceHeartbeat } = require("./Authentication/HandleDeviceHeartbeat");
const { handleRegisterDevice } = require("./Authentication/HandleRegisterDevice");
const { ensureLogin } = require("./Plugins/EnsureLogin");

function handleAuthenticationEndpoints(server)
{
    server.handle
    ({
        routePath: `/Login`,
        handler: handleLogin,
    });

    function wrap(fn)
    {
        return async (req, res) =>
        {
            try
            {
                await fn(req, res);
            }
            catch (handlerError)
            {
                console.error(`Error in route: ${req.url}`);
                console.error(handlerError);
            }
        };
    }

    server.handle
    ({
        routePath: `/Login/Callback`,
        handler: wrap(handleLoginCallback)
    });

    server.handle
    ({
        routePath: `/GetUser`,
        handler: handleGetUser
    });

    server.handle
    ({
        routePath: `/Logout`,
        handler: handleLogout
    });

    server.handle
    ({
        routePath: `/UpdateUserAdditionalData`,
        handler: wrap(handleUpdateUserAdditionalData),
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureLogin]
    });

    server.handle
    ({
        routePath: `/Auth/Devices`,
        handler: wrap(handleListDevices),
        method: PacketronRequestMethod.GET,
        plugins: [ensureLogin]
    });

    server.handle
    ({
        routePath: `/Auth/Devices/SignOut`,
        handler: wrap(handleSignOutDevice),
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureLogin]
    });

    server.handle
    ({
        routePath: `/Auth/Devices/Register`,
        handler: wrap(handleRegisterDevice),
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureLogin]
    });

    server.handle
    ({
        routePath: `/Auth/Heartbeat`,
        handler: wrap(handleDeviceHeartbeat),
        method: PacketronRequestMethod.POST,
        plugins: [ensureLogin]
    });
}

module.exports = { handleAuthenticationEndpoints };
