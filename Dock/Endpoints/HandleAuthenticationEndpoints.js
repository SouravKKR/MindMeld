const authenticationProviders = require("../Globals/Enumerations/AuthenticationProviders");
const { Packetron, PacketronHandlerFlags, PacketronPlugin, PacketronRequestMethod } = require("@gamiumgamers/packetron");
const { handleLogin } = require("./Authentication/HandleLogin");
const { handleLoginCallback } = require("./Authentication/HandleLoginCallback");
const { handleGetUser } = require("./Authentication/HandleGetUser");
const { handleLogout } = require("./Authentication/HandleLogout");
const { handleDeleteAccount } = require("./Authentication/HandleDeleteAccount");
const { handleUpdateUserAdditionalData } = require("./Authentication/HandleUpdateUserAdditionalData");
const { handleListDevices } = require("./Authentication/HandleListDevices");
const { handleSignOutDevice } = require("./Authentication/HandleSignOutDevice");
const { handleDeviceHeartbeat } = require("./Authentication/HandleDeviceHeartbeat");
const { handleRegisterDevice } = require("./Authentication/HandleRegisterDevice");
const { handleRequestOtp } = require("./Authentication/HandleRequestOtp");
const { handleVerifyOtp } = require("./Authentication/HandleVerifyOtp");
const { ensureLogin } = require("./Plugins/EnsureLogin");
const { ensureLoginRateLimit } = require("./Plugins/EnsureLoginRateLimit");

function handleAuthenticationEndpoints(server)
{
    server.handle
    ({
        routePath: `/Login`,
        handler: handleLogin,
        plugins: [ensureLoginRateLimit]
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
        handler: wrap(handleLoginCallback),
        plugins: [ensureLoginRateLimit]
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
        routePath: `/Auth/DeleteAccount`,
        handler: wrap(handleDeleteAccount),
        method: PacketronRequestMethod.POST,
        plugins: [ensureLogin]
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

    server.handle
    ({
        routePath: `/Auth/RequestOtp`,
        handler: wrap(handleRequestOtp),
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST
    });

    server.handle
    ({
        routePath: `/Auth/VerifyOtp`,
        handler: wrap(handleVerifyOtp),
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST
    });
}

module.exports = { handleAuthenticationEndpoints };
