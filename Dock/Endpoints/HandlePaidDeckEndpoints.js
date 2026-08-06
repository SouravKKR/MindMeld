const { PacketronHandlerFlags, PacketronRequestMethod } = require("@gamiumgamers/packetron");
const { ensureLogin } = require("./Plugins/EnsureLogin");
const { ecdhResponseEnvelope } = require("./Plugins/EcdhResponseEnvelope");
const { noCache } = require("./Plugins/NoCache");
const { ensurePaymentAccess } = require("./Plugins/EnsurePaymentAccess");
const { ensurePaymentRequestSchema } = require("./Plugins/EnsurePaymentRequestSchema");
const { browsePaidDeckLibrary } = require("./PaidDeck/BrowsePaidDeckLibrary");
const { initiatePurchase } = require("./PaidDeck/InitiatePurchase");
const { verifyPurchase } = require("./PaidDeck/VerifyPurchase");
const { getMyPurchases } = require("./PaidDeck/GetMyPurchases");
const { getPurchaseInvoice } = require("./PaidDeck/GetPurchaseInvoice");
const { logScreenshotAttempt } = require("./PaidDeck/LogScreenshotAttempt");
const { searchPaidDecks } = require("./PaidDeck/SearchPaidDecks");
const { getPaidDeckFilters } = require("./PaidDeck/GetPaidDeckFilters");
const { getPaidDeckDetails } = require("./PaidDeck/GetPaidDeckDetails");
const PaidDeckShareConstants = require("../Globals/Constants/PaidDeckShareConstants");
const { setPaidDeckPassword } = require("./PaidDeck/SetPaidDeckPassword");
const { unlockPaidDeckSession } = require("./PaidDeck/UnlockPaidDeckSession");
const { changePaidDeckPassword } = require("./PaidDeck/ChangePaidDeckPassword");
const { getPaidDeckManifest } = require("./PaidDeck/GetPaidDeckManifest");
const { fetchPaidDeckEntities } = require("./PaidDeck/FetchPaidDeckEntities");
const { updatePaidDeckEntity } = require("./PaidDeck/UpdatePaidDeckEntity");
const { addPaidDeckCopy } = require("./PaidDeck/AddPaidDeckCopy");
const { deletePaidDeckCopy } = require("./PaidDeck/DeletePaidDeckCopy");
const { updatePaidDeckCopyContent } = require("./PaidDeck/UpdatePaidDeckCopyContent");

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

    // Public single-listing lookup, used by the share/QR deep link to rebuild a
    // storefront page from nothing but a deck ID.
    server.handle
    ({
        routePath: PaidDeckShareConstants.DETAILS_ENDPOINT_PATH,
        handler: getPaidDeckDetails,
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
        plugins: [ensureLogin, ensurePaymentAccess, ensurePaymentRequestSchema, noCache]
    });

    server.handle
    ({
        routePath: `/PaidDecks/Purchase/Verify`,
        handler: verifyPurchase,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureLogin, ensurePaymentAccess, ensurePaymentRequestSchema, noCache]
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
        routePath: `/PaidDecks/ScreenshotAttempt`,
        handler: logScreenshotAttempt,
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

    // ── Copies (multi-instance) ──────────────────────────────────────────
    //
    // A buyer can hold several independent copies of one owned paid deck
    // (detached progress, shared immutable content + one license/content key).
    // Plain success/failure replies (no key material) so no ECDH envelope.
    server.handle
    ({
        routePath: `/PaidDecks/Copies/Add`,
        handler: addPaidDeckCopy,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureLogin]
    });

    // Moves ONE copy onto the publisher's current content version, keeping
    // progress and edits for every entity the publisher did not change.
    // dryRun:true returns only the counts, so the confirm dialog can tell the
    // buyer exactly what they are about to lose.
    server.handle
    ({
        routePath: `/PaidDecks/Copies/UpdateContent`,
        handler: updatePaidDeckCopyContent,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureLogin]
    });

    server.handle
    ({
        routePath: `/PaidDecks/Copies/Delete`,
        handler: deletePaidDeckCopy,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureLogin]
    });
}

module.exports = { handlePaidDeckEndpoints };
