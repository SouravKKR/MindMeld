const { PacketronRequestMethod } = require("@gamiumgamers/packetron");
const { getModelManifest } = require("./GetModelManifest");
const { ensureLogin } = require("../Plugins/EnsureLogin");


/**
 * Registers the offline-AI model serving endpoints. The model files live
 * under Dock/Assets/Models/<folderName>/ — one folder per entry in
 * Common/Constants/BrowserLlmModelCatalogue.json — and are served as static
 * content from the `/Assets/*` route registered in Dock/index.js.
 *
 *   GET /BrowserLlm/Manifest — Lists every catalogue model that is present
 *       and complete on this node, with its file list and sizes, so the
 *       client can pick one that suits the device and drive a progress bar.
 *
 * There is deliberately no query endpoint here: the Free tier runs entirely
 * in the browser and never sends a prompt to the server. The paid tiers are
 * served by /AskAi/Query/* instead.
 */
function handleBrowserLlmEndpoints(server)
{
    server.handle
    ({
        routePath: `/BrowserLlm/Manifest`,
        handler:   getModelManifest,
        method:    PacketronRequestMethod.GET,
        plugins:   [ensureLogin]
    });
}

module.exports = { handleBrowserLlmEndpoints };
