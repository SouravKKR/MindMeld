const { PacketronRequestMethod } = require("@gamiumgamers/packetron");
const { getModelManifest } = require("./GetModelManifest");
const { ensureLogin } = require("../Plugins/EnsureLogin");


/**
 * Registers the offline-AI model serving endpoints. The actual model
 * files live under Dock/Assets/Models/<MODEL_ID>/ and are served as
 * static content from the `/Assets/*` route registered in Dock/index.js.
 *
 *   GET /BrowserLlm/Manifest — Lists the shards / wasm / tokenizer
 *       files the frontend should fetch (+ sizes) so it can drive a
 *       progress bar and pre-warm the Cache API.
 *
 * Tier-query endpoints (Basic / Pro / Pro Plus → server-side Gemini
 * dispatch) will land here in a follow-up. They're out of scope for
 * this UI-only round.
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
