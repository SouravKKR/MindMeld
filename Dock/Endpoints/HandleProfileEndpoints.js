const { PacketronRequestMethod, PacketronHandlerFlags } = require("@gamiumgamers/packetron");
const { clearUserData } = require("./Profile/ClearUserData");
const { redeemPromoCode } = require("./Profile/RedeemPromoCode");
const { redeemCoupon } = require("./Profile/RedeemCoupon");
const { ensureLogin } = require("./Plugins/EnsureLogin");
const {httpStatus} = require("../Globals/Enumerations/HttpStatus");

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
                response.sendStatusCode(httpStatus.INTERNAL_SERVER_ERROR);
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

    server.handle
    ({
        routePath: `/Profile/RedeemPromoCode`,
        handler: wrapHandler(redeemPromoCode),
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureLogin]
    });

    server.handle
    ({
        routePath: `/Profile/RedeemCoupon`,
        handler: wrapHandler(redeemCoupon),
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureLogin]
    });
}

module.exports = { handleProfileEndpoints };
