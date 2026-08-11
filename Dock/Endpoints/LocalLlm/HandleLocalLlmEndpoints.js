const { PacketronRequestMethod } = require("@gamiumgamers/packetron");
const { getModelManifest } = require("./GetModelManifest");
const { ensureLogin } = require("../Plugins/EnsureLogin");
const LocalLlmDownloadConstants = require("../../Globals/Constants/LocalLlmDownloadConstants");


/**
 * Registers the offline-AI model serving endpoints. The model files live
 * under Dock/Assets/Models/<folderName>/ — one folder per entry in
 * Common/Constants/LocalLlmModelCatalogue.json — and are served as static
 * content from the `/Assets/*` route registered in Dock/index.js.
 *
 *   GET /LocalLlm/Manifest — Lists every catalogue model that is present
 *       and complete on this node, with its file list and sizes, so the
 *       client can pick one that suits the device and drive a progress bar.
 *
 *   GET /BrowserLlm/Manifest — the same handler under the subsystem's former
 *       name. It is not deprecated-but-tolerated, it is REQUIRED for one
 *       release: the app shell is a cached single-page bundle, so a browser
 *       that loaded the site before this deploy keeps running the old code and
 *       keeps asking for the old path. Serving only the new route would answer
 *       those clients with a 404, which the manifest client reports as
 *       MANIFEST_UNREACHABLE — the tier silently goes unavailable on every
 *       device that has not yet picked up the new bundle. Removable once the
 *       cache lifetime of the pre-rename bundle has certainly passed.
 *
 * There is deliberately no query endpoint here: the Free tier runs entirely
 * on the device and never sends a prompt to the server. The paid tiers are
 * served by /AskAi/Query/* instead.
 */
function handleLocalLlmEndpoints(server)
{
    const routePaths = [
        LocalLlmDownloadConstants.MANIFEST_ENDPOINT_PATH,
        LocalLlmDownloadConstants.LEGACY_MANIFEST_ENDPOINT_PATH,
    ];

    for (const routePath of routePaths)
    {
        server.handle
        ({
            routePath: routePath,
            handler:   getModelManifest,
            method:    PacketronRequestMethod.GET,
            plugins:   [ensureLogin]
        });
    }
}

module.exports = { handleLocalLlmEndpoints };
