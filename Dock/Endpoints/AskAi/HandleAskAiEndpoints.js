const { PacketronRequestMethod, PacketronHandlerFlags } = require("@gamiumgamers/packetron");
const { ensureLogin } = require("../Plugins/EnsureLogin");
const { handleQueryBasic } = require("./QueryBasic");
const { handleQueryPro } = require("./QueryPro");
const { handleQueryProPlus } = require("./QueryProPlus");
const { handleChatStrategy } = require("./ChatStrategy");


/**
 * Registers the AskAi streaming endpoints.
 *
 *   POST /AskAi/Query/Basic
 *   POST /AskAi/Query/Pro
 *   POST /AskAi/Query/ProPlus
 *
 * All three are login-gated and credit-metered: each handler resolves
 * the user, AskAiStreamRunner runs a CreditPreflight check against the
 * tier's ASK_AI_* spend rule before spawning the worker (402 when the
 * user cannot afford it), and a CreditLedger charge fires on successful
 * stream completion. The per-tier spend rules are seeded with default
 * flat costs by CreditConfigurationStore and tuned in the admin panel.
 *
 * Each endpoint forwards to a shared subprocess shim
 * (AskAiStreamRunner) that spawns the Python worker — Dock holds no
 * Gemini SDK or prompt logic.
 *
 * The LocalLlm namespace stays reserved for the in-browser/local
 * Free model; these cloud endpoints are deliberately separated so
 * LocalLlm/Manifest doesn't conflate with cloud tier dispatch.
 */
function handleAskAiEndpoints(server)
{
    server.handle
    ({
        routePath: `/AskAi/Query/Basic`,
        handler: handleQueryBasic,
        method: PacketronRequestMethod.POST,
        flags: PacketronHandlerFlags.JSON_BODY,
        plugins: [ensureLogin],
    });

    server.handle
    ({
        routePath: `/AskAi/Query/Pro`,
        handler: handleQueryPro,
        method: PacketronRequestMethod.POST,
        flags: PacketronHandlerFlags.JSON_BODY,
        plugins: [ensureLogin],
    });

    server.handle
    ({
        routePath: `/AskAi/Query/ProPlus`,
        handler: handleQueryProPlus,
        method: PacketronRequestMethod.POST,
        flags: PacketronHandlerFlags.JSON_BODY,
        plugins: [ensureLogin],
    });

    // Deck-chat planning call (unmetered): returns retrieval N/M + alternate
    // phrasings; the metered answer is the /AskAi/Query/* stream above.
    server.handle
    ({
        routePath: `/AskAi/Chat/Strategy`,
        handler: handleChatStrategy,
        method: PacketronRequestMethod.POST,
        flags: PacketronHandlerFlags.JSON_BODY,
        plugins: [ensureLogin],
    });
}

module.exports = { handleAskAiEndpoints };
