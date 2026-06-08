const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");
const KeyManagementService = require("../../Globals/Classes/Security/KeyManagementService");

/**
 * GET /PaidDecks/CheckForContentUpdates
 *
 * Returns the subset of the caller's owned paid decks whose latest
 * published contentVersion is newer than what they last downloaded.
 * Lets the frontend show a "Check for paid deck updates" affordance
 * without having to scan the full library.
 */
async function checkForContentUpdates(request, response)
{
    const session = request.session;

    if (!session)
    {
        response.sendStatusCode(401);
        return;
    }

    const userId = session.getUserId();
    const licenses = await KeyManagementService.getLicensesForUser(userId);

    const activeLicenses = licenses.filter((license) => KeyManagementService.isLicenseActive(license));

    if (activeLicenses.length === 0)
    {
        response.statusCode = 200;
        response.sendJson({ updates: [] });
        return;
    }

    const ownedDeckIds = activeLicenses.map((license) => license.getDeckId());
    const database = await DatabaseConnector.getDatabase();
    const deckDocuments = await database
        .collection(DatabaseConstants.PAID_DECKS_COLLECTION)
        .find({ id: { $in: ownedDeckIds } })
        .toArray();

    const deckById = new Map();
    for (const deckDocument of deckDocuments)
    {
        deckById.set(deckDocument.id, deckDocument);
    }

    const updates = [];
    for (const license of activeLicenses)
    {
        const deckDocument = deckById.get(license.getDeckId());
        if (!deckDocument)
        {
            continue;
        }

        const currentVersion = deckDocument?.contentSummary?.contentVersion || 0;
        const downloadedVersion = license.getDownloadedContentVersion();

        if (currentVersion > downloadedVersion)
        {
            updates.push
            ({
                deckId: deckDocument.id,
                deckTitle: deckDocument.title,
                thumbnailUrl: deckDocument.thumbnailUrl,
                currentVersion: currentVersion,
                downloadedVersion: downloadedVersion
            });
        }
    }

    response.statusCode = 200;
    response.sendJson({ updates: updates });
}

module.exports = { checkForContentUpdates };
