const { PacketronHandlerFlags, PacketronRequestMethod } = require("@gamiumgamers/packetron");
const { handleRazorpayWebhook } = require("./Webhook/HandleRazorpayWebhook");
const { handleZohoWebhook } = require("./Webhook/HandleZohoWebhook");


function handleWebhookEndpoints(server)
{
    // PLAIN_TEXT_BODY (not JSON_BODY) for both — the HMAC signature is computed
    // over the raw bytes the provider sent. JSON_BODY would parse + lose the
    // original byte stream, breaking signature verification.

    // Zoho Payments — the active provider driving every checkout in the UI.
    server.handle
    ({
        routePath: `/Webhooks/Zoho`,
        handler: handleZohoWebhook,
        flags: PacketronHandlerFlags.PLAIN_TEXT_BODY,
        method: PacketronRequestMethod.POST,
        plugins: []
    });

    // Razorpay — retained server-side; no UI initiates it, but the webhook
    // stays live so any in-flight / legacy Razorpay order can still reconcile.
    server.handle
    ({
        routePath: `/Webhooks/Razorpay`,
        handler: handleRazorpayWebhook,
        flags: PacketronHandlerFlags.PLAIN_TEXT_BODY,
        method: PacketronRequestMethod.POST,
        plugins: []
    });
}

module.exports = { handleWebhookEndpoints };
