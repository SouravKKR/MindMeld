const { PacketronHandlerFlags, PacketronRequestMethod } = require("@gamiumgamers/packetron");
const { ensureLogin } = require("./Plugins/EnsureLogin");
const { browsePaidDeckLibrary } = require("./PaidDeck/BrowsePaidDeckLibrary");
const { initiatePurchase } = require("./PaidDeck/InitiatePurchase");
const { verifyPurchase } = require("./PaidDeck/VerifyPurchase");
const { getMyPurchases } = require("./PaidDeck/GetMyPurchases");
const { getPurchaseInvoice } = require("./PaidDeck/GetPurchaseInvoice");
const { getPaidDeckContent } = require("./PaidDeck/GetPaidDeckContent");
const { logScreenshotAttempt } = require("./PaidDeck/LogScreenshotAttempt");
const { searchPaidDecks } = require("./PaidDeck/SearchPaidDecks");
const { getPaidDeckFilters } = require("./PaidDeck/GetPaidDeckFilters");

function handlePaidDeckEndpoints(server)
{
    server.handle
    ({
        routePath: `/PaidDecks/Library`,
        handler: browsePaidDeckLibrary,
        method: PacketronRequestMethod.GET
    });

    server.handle
    ({
        routePath: `/PaidDecks/Filters`,
        handler: getPaidDeckFilters,
        method: PacketronRequestMethod.GET
    });

    server.handle
    ({
        routePath: `/PaidDecks/Search`,
        handler: searchPaidDecks,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST
    });

    server.handle
    ({
        routePath: `/PaidDecks/Purchase/Initiate`,
        handler: initiatePurchase,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureLogin]
    });

    server.handle
    ({
        routePath: `/PaidDecks/Purchase/Verify`,
        handler: verifyPurchase,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureLogin]
    });

    server.handle
    ({
        routePath: `/PaidDecks/MyPurchases`,
        handler: getMyPurchases,
        method: PacketronRequestMethod.GET,
        plugins: [ensureLogin]
    });

    server.handle
    ({
        routePath: `/PaidDecks/Purchases/Invoice`,
        handler: getPurchaseInvoice,
        method: PacketronRequestMethod.GET,
        plugins: [ensureLogin]
    });

    server.handle
    ({
        routePath: `/PaidDecks/Content`,
        handler: getPaidDeckContent,
        method: PacketronRequestMethod.GET,
        plugins: [ensureLogin]
    });

    server.handle
    ({
        routePath: `/PaidDecks/ScreenshotAttempt`,
        handler: logScreenshotAttempt,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureLogin]
    });
}

module.exports = { handlePaidDeckEndpoints };
