const { PacketronHandlerFlags, PacketronRequestMethod } = require("@gamiumgamers/packetron");
const { ensureLogin } = require("./Plugins/EnsureLogin");
const { handleQueueDeckAnalysis } = require("./Analysis/QueueDeckAnalysis");


function handleAnalysisEndpoints(server)
{
    // ensureLogin gates the route at the plugin layer, matching every other
    // authenticated endpoint. The handler keeps its own getUser null-check as
    // defence-in-depth (and because it needs the resolved User object anyway).
    server.handle
    ({
        routePath: `/Analysis/QueueDeckAnalysis`,
        handler: handleQueueDeckAnalysis,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureLogin],
    });
}

module.exports = { handleAnalysisEndpoints };
