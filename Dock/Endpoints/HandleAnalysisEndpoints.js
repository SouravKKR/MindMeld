const { PacketronHandlerFlags, PacketronRequestMethod } = require("@gamiumgamers/packetron");
const { handleQueueDeckAnalysis } = require("./Analysis/QueueDeckAnalysis");


function handleAnalysisEndpoints(server)
{
    server.handle
    ({
        routePath: `/Analysis/QueueDeckAnalysis`,
        handler: handleQueueDeckAnalysis,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
    });
}

module.exports = { handleAnalysisEndpoints };
