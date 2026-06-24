const { getUser } = require("../Helpers/GetUser");
const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");

/**
 * POST /Auth/DeleteAccount
 *
 * Permanently and irreversibly deletes the signed-in user's account. Unlike
 * /Profile/ClearUserData — which empties the user's content but keeps the
 * account (and its sessionId cookie) alive — this removes the user row itself
 * along with every record keyed to that userId, invalidates all of the user's
 * sessions on every device, and clears the sessionId cookie so the current
 * browser is signed out immediately.
 *
 * The destructive nature of this endpoint is gated client-side behind a
 * typed-confirmation DialogBox prompt; the server still re-checks the session
 * so a stray request without a valid cookie is rejected with 401.
 */
async function handleDeleteAccount(request, response)
{
    const user = await getUser(request);

    if(!user)
    {
        response.sendStatusCode(httpStatus.UNAUTHORIZED);
        return;
    }

    const userId = user.getId();
    const database = await DatabaseConnector.getDatabase();

    // Every collection below stores rows keyed by `userId`. Wiping them all
    // leaves no orphaned content, licenses, sessions or audit rows behind for
    // the deleted account. The user row in USERS_COLLECTION is removed last so
    // that if any earlier delete throws, the account still exists and the
    // operation can be safely retried.
    const collectionsToWipe =
    [
        DatabaseConstants.DECKS_COLLECTION,
        DatabaseConstants.CARDS_COLLECTION,
        DatabaseConstants.STUDY_MATERIALS_COLLECTION,
        DatabaseConstants.MOCK_TESTS_COLLECTION,
        DatabaseConstants.DELETIONS_COLLECTION,
        DatabaseConstants.SYNC_DATA_COLLECTION,
        DatabaseConstants.CREDIT_TRANSACTIONS_COLLECTION,
        DatabaseConstants.PURCHASES_COLLECTION,
        DatabaseConstants.DECK_LICENSES_COLLECTION,
        DatabaseConstants.PAID_DECK_USER_CONTENT_COLLECTION,
        DatabaseConstants.PAID_DECK_USER_CONTENT_ENTITIES_COLLECTION,
        DatabaseConstants.UPLOAD_QUOTAS_COLLECTION,
        DatabaseConstants.SCREENSHOT_EVENTS_COLLECTION,
        DatabaseConstants.TASK_HISTORY_COLLECTION,
        DatabaseConstants.ORGANIZATION_MEMBERS_COLLECTION,
        DatabaseConstants.PROMO_CODE_REDEMPTIONS_COLLECTION,
        DatabaseConstants.DEVICES_COLLECTION,
        DatabaseConstants.SESSIONS_COLLECTION
    ];

    const wipeCounts = {};

    for(let collectionIndex = 0; collectionIndex < collectionsToWipe.length; collectionIndex++)
    {
        const collectionName = collectionsToWipe[collectionIndex];
        const deleteResult = await database.collection(collectionName).deleteMany({ userId: userId });
        wipeCounts[collectionName] = deleteResult.deletedCount || 0;
    }

    // Finally remove the account itself.
    const userDeleteResult = await database
        .collection(DatabaseConstants.USERS_COLLECTION)
        .deleteOne({ id: userId });
    wipeCounts[DatabaseConstants.USERS_COLLECTION] = userDeleteResult.deletedCount || 0;

    // The session rows are gone, so the cookie is already invalid server-side —
    // clear it client-side too so the browser stops presenting a dead cookie.
    // Attributes mirror the setCookie call in HandleLoginCallback / HandleLogout.
    response.clearCookie("sessionId",
    {
        path: "/",
        httpOnly: true,
        secure: true,
        sameSite: "lax"
    });

    console.log(`[DeleteAccount] Permanently deleted account ${userId}:`, wipeCounts);

    response.sendJson({ ok: true, deleted: wipeCounts });
}

module.exports = { handleDeleteAccount };
