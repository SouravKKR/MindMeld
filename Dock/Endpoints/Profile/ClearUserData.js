const { getUser } = require("../Helpers/GetUser");
const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");

/**
 * POST /Profile/ClearUserData
 *
 * Wipes every user-owned record from CogniumLearn's database — decks, cards,
 * study materials, mock tests, sync metadata, and accumulated tombstones.
 * The user account itself stays intact (no users-collection delete) so the
 * sessionId cookie remains valid and the next page load lands the user on
 * an empty home page from a server perspective.
 *
 * Local IndexedDB and the session are NOT touched here — the client decides
 * what to do with them. Per product spec the default flow leaves them alone
 * and the user manually clears local data if they want a full reset.
 */
async function clearUserData(request, response)
{
    const user = await getUser(request);

    if(!user)
    {
        response.sendStatusCode(httpStatus.UNAUTHORIZED);
        return;
    }

    const userId = user.getId();
    const database = await DatabaseConnector.getDatabase();

    const collectionsToWipe =
    [
        DatabaseConstants.DECKS_COLLECTION,
        DatabaseConstants.CARDS_COLLECTION,
        DatabaseConstants.STUDY_MATERIALS_COLLECTION,
        DatabaseConstants.MOCK_TESTS_COLLECTION,
        DatabaseConstants.DELETIONS_COLLECTION,
        DatabaseConstants.SYNC_DATA_COLLECTION,
        // The credit ledger is part of the user's data. The account-level
        // balance (users.additionalData.credits) is intentionally left
        // intact — clearing content must not erase earned/purchased credits —
        // but the transaction history is removed alongside the rest. Clearing
        // the signup:{userId} row also keeps the welcome grant re-applicable
        // if the account is ever truly deleted and recreated.
        DatabaseConstants.CREDIT_TRANSACTIONS_COLLECTION
    ];

    const wipeCounts = {};

    for(let collectionIndex = 0; collectionIndex < collectionsToWipe.length; collectionIndex++)
    {
        const collectionName = collectionsToWipe[collectionIndex];
        const deleteResult = await database.collection(collectionName).deleteMany({ userId: userId });
        wipeCounts[collectionName] = deleteResult.deletedCount || 0;
    }

    console.log(`[ClearUserData] Wiped server data for user ${userId}:`, wipeCounts);

    response.sendJson({ ok: true, cleared: wipeCounts });
}

module.exports = { clearUserData };
