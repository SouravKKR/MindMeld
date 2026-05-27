const { PacketronRequestMethod, PacketronHandlerFlags } = require("@gamiumgamers/packetron");
const { ensureAdmin } = require("../Plugins/EnsureAdmin");
const { handleQueryBasic } = require("./QueryBasic");
const { handleQueryPro } = require("./QueryPro");
const { handleQueryProPlus } = require("./QueryProPlus");


/**
 * Registers the AskAi streaming endpoints.
 *
 *   POST /AskAi/Query/Basic
 *   POST /AskAi/Query/Pro
 *   POST /AskAi/Query/ProPlus
 *
 * All three are admin-gated (NOT ensureLogin) for the duration of the
 * closed-test phase — the gate is centralised on the client via
 * AiFeatureGate, but every endpoint repeats the check server-side so a
 * non-admin who skips the UI can't smash the API directly.
 *
 * Each endpoint forwards to a shared subprocess shim
 * (AskAiStreamRunner) that spawns the Python worker — Dock holds no
 * Gemini SDK or prompt logic.
 *
 * The BrowserLlm namespace stays reserved for the in-browser/local
 * Free model; these cloud endpoints are deliberately separated so
 * BrowserLlm/Manifest doesn't conflate with cloud tier dispatch.
 */
function handleAskAiEndpoints(server)
{
    server.handle
    ({
        routePath: `/AskAi/Query/Basic`,
        handler:   handleQueryBasic,
        method:    PacketronRequestMethod.POST,
        flags:     PacketronHandlerFlags.JSON_BODY,
        plugins:   [ensureAdmin],
    });

    server.handle
    ({
        routePath: `/AskAi/Query/Pro`,
        handler:   handleQueryPro,
        method:    PacketronRequestMethod.POST,
        flags:     PacketronHandlerFlags.JSON_BODY,
        plugins:   [ensureAdmin],
    });

    server.handle
    ({
        routePath: `/AskAi/Query/ProPlus`,
        handler:   handleQueryProPlus,
        method:    PacketronRequestMethod.POST,
        flags:     PacketronHandlerFlags.JSON_BODY,
        plugins:   [ensureAdmin],
    });
}

module.exports = { handleAskAiEndpoints };
