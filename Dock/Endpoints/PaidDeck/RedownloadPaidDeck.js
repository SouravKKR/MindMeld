const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");
const KeyManagementService = require("../../Globals/Classes/Security/KeyManagementService");

/**
 * POST /PaidDecks/Redownload
 *
 * Re-issues the caller's license at the deck's current keyVersion so
 * the next GetPaidDeckContent call returns the latest encrypted asset.
 * The existing license's expiresAt and grantSource are preserved so
 * an org-perk-issued time-limited license keeps its expiry through
 * the redownload (parity with rotateKeysForDeck's preservation logic).
 *
 * The actual mark-as-downloaded step happens AFTER the client
 * successfully decrypts and stores the new asset (see
 * /PaidDecks/MarkVersionDownloaded) — we only set things up here.
 */
async function redownloadPaidDeck(request, response)
{
    const session = request.session;

    if (!session)
    {
        response.sendStatusCode(401);
        return;
    }

    const body = await request.getBody();
    const deckId = body?.deckId;

    if (!deckId)
    {
        response.statusCode = 400;
        response.sendJson({ error: "MISSING_DECK_ID" });
        return;
    }

    const userId = session.getUserId();
    const existingLicense = await KeyManagementService.getLicense(userId, deckId);

    if (!KeyManagementService.isLicenseActive(existingLicense))
    {
        response.statusCode = 403;
        response.sendJson({ error: "NO_ACTIVE_LICENSE" });
        return;
    }

    const result = await KeyManagementService.issueLicenseForDeck
    (
        userId,
        deckId,
        {
            expiresAt: existingLicense.getExpiresAt(),
            grantSource: existingLicense.getGrantSource()
        }
    );

    if (!result.success)
    {
        response.statusCode = result.reason === "DECK_NOT_FOUND" ? 404 : 503;
        response.sendJson({ error: result.reason });
        return;
    }

    const database = await DatabaseConnector.getDatabase();
    const deckDocument = await database
        .collection(DatabaseConstants.PAID_DECKS_COLLECTION)
        .findOne({ id: deckId });

    response.statusCode = 200;
    response.sendJson
    ({
        success: true,
        deckId: deckId,
        keyVersion: result.license.getKeyVersion(),
        contentVersion: deckDocument?.contentSummary?.contentVersion || 0
    });
}

module.exports = { redownloadPaidDeck };
