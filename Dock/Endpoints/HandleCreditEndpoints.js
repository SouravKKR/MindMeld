const { PacketronHandlerFlags, PacketronRequestMethod } = require("@gamiumgamers/packetron");
const { ensureLogin } = require("./Plugins/EnsureLogin");
const { noCache } = require("./Plugins/NoCache");
const { ensurePaymentAccess } = require("./Plugins/EnsurePaymentAccess");
const { ensurePaymentRequestSchema } = require("./Plugins/EnsurePaymentRequestSchema");
const { getCreditPurchaseOptions } = require("./Credits/GetCreditPurchaseOptions");
const { initiateCreditPurchase } = require("./Credits/InitiateCreditPurchase");
const { verifyCreditPurchase } = require("./Credits/VerifyCreditPurchase");

// Every response below carries a live price quote, a provider order id or a
// settlement outcome. `noCache` keeps all three out of shared caches and
// browser back-forward restores — a stale quote would show the buyer a price
// the server no longer honours, and a cached settlement response would report
// success for an order that has since been replayed or refunded.
function handleCreditEndpoints(server)
{
    server.handle
    ({
        routePath: `/Credits/Purchase/Options`,
        handler: getCreditPurchaseOptions,
        method: PacketronRequestMethod.GET,
        plugins: [ensureLogin, noCache]
    });

    server.handle
    ({
        routePath: `/Credits/Purchase/Initiate`,
        handler: initiateCreditPurchase,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureLogin, ensurePaymentAccess, ensurePaymentRequestSchema, noCache]
    });

    server.handle
    ({
        routePath: `/Credits/Purchase/Verify`,
        handler: verifyCreditPurchase,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureLogin, ensurePaymentAccess, ensurePaymentRequestSchema, noCache]
    });
}

module.exports = { handleCreditEndpoints };
