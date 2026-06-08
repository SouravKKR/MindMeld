const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");
const KeyManagementService = require("../../Globals/Classes/Security/KeyManagementService");

/**
 * POST /PaidDecks/MarkVersionDownloaded
 *
 * Stamps the caller's DeckLicense.downloadedContentVersion after the
 * client has successfully decrypted + stored the latest paid-deck
 * payload locally. Only advances the version forward — never lowers
 * it — so a stale concurrent call can't accidentally make the deck
 * "outdated again" in the check-for-updates listing.
 */
async function markVersionDownloaded(request, response)
{
    const session = request.session;

    if (!session)
    {
        response.sendStatusCode(401);
        return;
    }

    const body = await request.getBody();
    const deckId = body?.deckId;
    const contentVersion = Number(body?.contentVersion);

    if (!deckId || !Number.isFinite(contentVersion) || contentVersion < 0)
    {
        response.statusCode = 400;
        response.sendJson({ error: "MISSING_OR_INVALID_PARAMETERS" });
        return;
    }

    const userId = session.getUserId();
    const database = await DatabaseConnector.getDatabase();
    // Touch rotatedAt alongside the version bump so the PullLicenses
    // sync filter (rotatedAt > sinceDate) picks up the change on the
    // next regular sync. Without this, the bumped version would be
    // server-side-only until something else triggered a license update.
    const result = await database
        .collection(DatabaseConstants.DECK_LICENSES_COLLECTION)
        .updateOne
        (
            {
                userId: userId,
                deckId: deckId,
                $or:
                [
                    { downloadedContentVersion: { $lt: contentVersion } },
                    { downloadedContentVersion: { $exists: false } }
                ]
            },
            { $set: { downloadedContentVersion: contentVersion, rotatedAt: new Date() } }
        );

    response.statusCode = 200;
    response.sendJson({ success: true, advanced: result.modifiedCount > 0 });
}

module.exports = { markVersionDownloaded };
