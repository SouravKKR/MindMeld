const { PacketronHandlerFlags, PacketronRequestMethod } = require("@gamiumgamers/packetron");
const { handleRazorpayWebhook } = require("./Webhook/HandleRazorpayWebhook");


function handleWebhookEndpoints(server)
{
    // PLAIN_TEXT_BODY (not JSON_BODY) — the HMAC signature is computed
    // over the raw bytes Razorpay sent. JSON_BODY would parse + lose
    // the original byte stream, breaking signature verification.
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
