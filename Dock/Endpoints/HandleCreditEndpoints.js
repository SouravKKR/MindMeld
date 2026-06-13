const { PacketronHandlerFlags, PacketronRequestMethod } = require("@gamiumgamers/packetron");
const { ensureLogin } = require("./Plugins/EnsureLogin");
const { getCreditPurchaseOptions } = require("./Credits/GetCreditPurchaseOptions");
const { initiateCreditPurchase } = require("./Credits/InitiateCreditPurchase");
const { verifyCreditPurchase } = require("./Credits/VerifyCreditPurchase");

function handleCreditEndpoints(server)
{
    server.handle
    ({
        routePath: `/Credits/Purchase/Options`,
        handler: getCreditPurchaseOptions,
        method: PacketronRequestMethod.GET,
        plugins: [ensureLogin]
    });

    server.handle
    ({
        routePath: `/Credits/Purchase/Initiate`,
        handler: initiateCreditPurchase,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureLogin]
    });

    server.handle
    ({
        routePath: `/Credits/Purchase/Verify`,
        handler: verifyCreditPurchase,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureLogin]
    });
}

module.exports = { handleCreditEndpoints };
