const { PacketronHandlerFlags, PacketronRequestMethod } = require("@gamiumgamers/packetron");
const { handleEvaluateAttempt } = require("./MockTest/EvaluateAttempt");
const { ensureLogin } = require("./Plugins/EnsureLogin");


function handleMockTestEndpoints(server)
{
    server.handle
    ({
        routePath: `/MockTest/EvaluateAttempt`,
        handler: handleEvaluateAttempt,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ ensureLogin ]
    });
}


module.exports = { handleMockTestEndpoints };
