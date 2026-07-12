const { PacketronHandlerFlags, PacketronRequestMethod } = require("@gamiumgamers/packetron");
const { handleEvaluateAttempt } = require("./MockTest/EvaluateAttempt");
const { handleTranscribeOfflineAttempt } = require("./MockTest/TranscribeOfflineAttempt");
const { handleGetTranscriptionResult } = require("./MockTest/GetTranscriptionResult");
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

    server.handle
    ({
        routePath: `/MockTest/TranscribeOfflineAttempt`,
        handler: handleTranscribeOfflineAttempt,
        flags: PacketronHandlerFlags.MULTIPART_FORM_DATA,
        method: PacketronRequestMethod.POST,
        plugins: [ ensureLogin ]
    });

    server.handle
    ({
        routePath: `/MockTest/GetTranscriptionResult`,
        handler: handleGetTranscriptionResult,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ ensureLogin ]
    });
}


module.exports = { handleMockTestEndpoints };
