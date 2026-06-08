const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");
const KeyManagementService = require("../../Globals/Classes/Security/KeyManagementService");

async function getPaidDeckContent(request, response)
{
    const session = request.session;

    if (!session)
    {
        response.sendStatusCode(401);
        return;
    }

    const queryParams = await request.getQueryParams();
    const deckId = queryParams.deckId;

    if (!deckId)
    {
        response.statusCode = 400;
        response.sendJson({ error: "MISSING_DECK_ID" });
        return;
    }

    const license = await KeyManagementService.getLicense(session.getUserId(), deckId);

    if (!KeyManagementService.isLicenseActive(license))
    {
        // Covers: missing license, status != ACTIVE, AND expiresAt in the past.
        // Org-perk-issued licenses are time-bounded; after their durationDays
        // window the user must re-purchase at regular price.
        response.statusCode = 403;
        response.sendJson({ error: "NO_ACTIVE_LICENSE" });
        return;
    }

    const database = await DatabaseConnector.getDatabase();
    const deckDocument = await database
        .collection(DatabaseConstants.PAID_DECKS_COLLECTION)
        .findOne({ id: deckId });

    if (!deckDocument)
    {
        response.sendStatusCode(404);
        return;
    }

    const asset = await KeyManagementService.getAsset(deckId, license.getKeyVersion());

    if (!asset)
    {
        response.statusCode = 503;
        response.sendJson({ error: "ASSET_NOT_AVAILABLE" });
        return;
    }

    response.statusCode = 200;
    response.sendJson
    ({
        deckId: deckId,
        keyVersion: license.getKeyVersion(),
        ivBase64: asset.ivBase64,
        ciphertextBase64: asset.ciphertextBase64,
        wrappedKeyBlob: license.getWrappedKeyBlob(),
        metadata:
        {
            title: deckDocument.title,
            description: deckDocument.description,
            tags: deckDocument.tags,
            thumbnailUrl: deckDocument.thumbnailUrl
        }
    });
}

module.exports = { getPaidDeckContent };
