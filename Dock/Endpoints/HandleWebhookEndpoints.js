const { PacketronHandlerFlags, PacketronRequestMethod } = require("@gamiumgamers/packetron");
const { handleRazorpayWebhook } = require("./Webhook/HandleRazorpayWebhook");


function handleWebhookEndpoints(server)
{
    // Razorpay is the sole payment provider: it creates every order and settles
    // every flow. This webhook is the server-to-server safety net for a buyer
    // who pays and then closes the tab before the browser verify leg runs.
    //
    // PLAIN_TEXT_BODY (not JSON_BODY) — the HMAC signature is computed over the
    // raw bytes Razorpay sent. JSON_BODY would parse and lose the original byte
    // stream, breaking signature verification.
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
