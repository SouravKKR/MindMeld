const { PacketronHandlerFlags, PacketronRequestMethod } = require("@gamiumgamers/packetron");
const { ensureLogin } = require("./Plugins/EnsureLogin");
const { ecdhResponseEnvelope } = require("./Plugins/EcdhResponseEnvelope");
const { browsePaidDeckLibrary } = require("./PaidDeck/BrowsePaidDeckLibrary");
const { initiatePurchase } = require("./PaidDeck/InitiatePurchase");
const { verifyPurchase } = require("./PaidDeck/VerifyPurchase");
const { getMyPurchases } = require("./PaidDeck/GetMyPurchases");
const { getPurchaseInvoice } = require("./PaidDeck/GetPurchaseInvoice");
const { getPaidDeckContent } = require("./PaidDeck/GetPaidDeckContent");
const { logScreenshotAttempt } = require("./PaidDeck/LogScreenshotAttempt");
const { searchPaidDecks } = require("./PaidDeck/SearchPaidDecks");
const { getPaidDeckFilters } = require("./PaidDeck/GetPaidDeckFilters");
const { checkForContentUpdates } = require("./PaidDeck/CheckForContentUpdates");
const { redownloadPaidDeck } = require("./PaidDeck/RedownloadPaidDeck");
const { markVersionDownloaded } = require("./PaidDeck/MarkVersionDownloaded");
const { setPaidDeckPassword } = require("./PaidDeck/SetPaidDeckPassword");
const { unlockPaidDeckSession } = require("./PaidDeck/UnlockPaidDeckSession");
const { changePaidDeckPassword } = require("./PaidDeck/ChangePaidDeckPassword");
const { getPaidDeckManifest } = require("./PaidDeck/GetPaidDeckManifest");
const { fetchPaidDeckEntities } = require("./PaidDeck/FetchPaidDeckEntities");
const { updatePaidDeckEntity } = require("./PaidDeck/UpdatePaidDeckEntity");

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

    server.handle
    ({
        routePath: `/PaidDecks/CheckForContentUpdates`,
        handler: checkForContentUpdates,
        method: PacketronRequestMethod.GET,
        plugins: [ensureLogin]
    });

    server.handle
    ({
        routePath: `/PaidDecks/Redownload`,
        handler: redownloadPaidDeck,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureLogin]
    });

    server.handle
    ({
        routePath: `/PaidDecks/MarkVersionDownloaded`,
        handler: markVersionDownloaded,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureLogin]
    });

    // ── Protected-study flow ─────────────────────────────────────────────
    //
    // Every endpoint below delivers something a leaked HTTPS dump
    // shouldn't reveal (the password-wrapped content key, the encrypted
    // manifest, encrypted entity bodies) so the response goes through
    // EcdhResponseEnvelope on top of HTTPS. SetPassword is intentionally
    // NOT ECDH-wrapped — its response is just success/failure and the
    // sensitive material flows the other way (client to server), which
    // is HTTPS-only either way.
    server.handle
    ({
        routePath: `/PaidDecks/SetPassword`,
        handler: setPaidDeckPassword,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureLogin]
    });

    server.handle
    ({
        routePath: `/PaidDecks/UnlockSession`,
        handler: unlockPaidDeckSession,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureLogin, ecdhResponseEnvelope]
    });

    server.handle
    ({
        routePath: `/PaidDecks/ChangePassword`,
        handler: changePaidDeckPassword,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureLogin]
    });

    server.handle
    ({
        routePath: `/PaidDecks/Manifest`,
        handler: getPaidDeckManifest,
        method: PacketronRequestMethod.GET,
        plugins: [ensureLogin, ecdhResponseEnvelope]
    });

    server.handle
    ({
        routePath: `/PaidDecks/Entities/Fetch`,
        handler: fetchPaidDeckEntities,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureLogin, ecdhResponseEnvelope]
    });

    server.handle
    ({
        routePath: `/PaidDecks/Entities/Update`,
        handler: updatePaidDeckEntity,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureLogin, ecdhResponseEnvelope]
    });
}

module.exports = { handlePaidDeckEndpoints };
