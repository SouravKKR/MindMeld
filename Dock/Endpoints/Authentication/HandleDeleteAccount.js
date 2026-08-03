const { getUser } = require("../Helpers/GetUser");
const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");
const InformationSourceQueryEngine = require("../../Globals/Classes/Database/InformationSourceQueryEngine");
const InformationSourcePurger = require("../../Globals/Classes/Content/InformationSourcePurger");
const EphemeralUploadRegistry = require("../../Globals/Classes/Content/EphemeralUploadRegistry");
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

    // Uploaded documents are purged FIRST and separately, because they are the
    // one thing a plain `deleteMany({ userId })` cannot reach: the document
    // itself lives in object storage, and its extracted page text and cached
    // figures sit in collections keyed on (userId, contentHash) rather than
    // being reachable from the row. Wiping the row alone would leave the
    // learner's uploaded books — and their verbatim extracted text — on the
    // platform after the account was deleted, which fails the erasure right
    // outright.
    //
    // Done before the bulk wipe so that if it throws, the account still exists
    // and the deletion can be retried, matching the ordering rationale below.
    let purgedSourceCount = 0;
    const userInformationSources = await InformationSourceQueryEngine.getInformationSourcesByUserId(userId);
    for (const userInformationSource of userInformationSources)
    {
        await InformationSourcePurger.purgeSingleSource(userInformationSource);
        purgedSourceCount++;
    }

    // Uploaded files that are NOT information sources — scanned answer sheets
    // and support-ticket attachments — live in object storage under their own
    // prefixes and are equally unreachable from a `deleteMany({ userId })`.
    // Erasure means now, not at the end of their retention window, so they are
    // purged here rather than left for the reaper.
    let purgedEphemeralPrefixCount = 0;
    try
    {
        purgedEphemeralPrefixCount = await EphemeralUploadRegistry.purgeAllForUser(userId);
    }
    catch (ephemeralPurgeError)
    {
        // Same ordering rationale as above: leave the account intact so the
        // deletion can be retried rather than half-completing an erasure.
        console.error(`[HandleDeleteAccount] Could not purge ephemeral uploads for ${userId}: ${ephemeralPurgeError?.message || ephemeralPurgeError}`);
        throw ephemeralPurgeError;
    }

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
        DatabaseConstants.AI_GENERATED_EXPORT_EVENTS_COLLECTION,
        DatabaseConstants.EPHEMERAL_UPLOADS_COLLECTION,
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
    wipeCounts[DatabaseConstants.INFORMATION_SOURCES_COLLECTION] = purgedSourceCount;
    // Reported separately from the row wipe above: that count is rows removed,
    // this one is object-storage prefixes emptied, and conflating them would
    // hide a failed blob purge behind a successful row delete.
    wipeCounts.ephemeralUploadPrefixesPurged = purgedEphemeralPrefixCount;

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
