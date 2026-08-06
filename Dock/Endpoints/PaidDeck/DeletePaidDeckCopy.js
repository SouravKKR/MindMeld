const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");
const KeyManagementService = require("../../Globals/Classes/Security/KeyManagementService");
const SyncQueryEngine = require("../../Globals/Classes/Database/SyncQueryEngine");
const LicenseClientView = require("../../Globals/Classes/Security/LicenseClientView");
const { removeInstanceFromLicense, buildPaidInstanceRowFilter } = require("./PaidDeckGrantHelpers");
const PaidDeckScopeResolver = require("../../Globals/Classes/PaidDeck/PaidDeckScopeResolver");
const { entityTypes } = require("../../Globals/Enumerations/EntityTypes");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");

/**
 * POST /PaidDecks/Copies/Delete
 *
 * Permanently deletes ONE copy of an owned paid deck: tears down that copy's
 * seeded rows (and their progress) and removes it from the license registry.
 * The LICENSE and content key are KEPT, so the buyer can re-add a fresh copy
 * later from the store while the license is valid. Sibling copies are never
 * touched (teardown is instance-scoped).
 *
 * Body : { deckId, instanceId }
 * Reply: { success, license }
 *
 * The license instances array is the source of truth and is updated first; the
 * server-side row teardown is best-effort defense-in-depth (the client's own
 * deck.delete() is the primary teardown path and emits the same tombstones).
 */
async function deletePaidDeckCopy(request, response)
{
    const session = request.session;
    if (!session)
    {
        response.sendStatusCode(httpStatus.UNAUTHORIZED);
        return;
    }

    const body = await request.getBody();
    const deckId = body?.deckId;
    const instanceId = body?.instanceId;

    if (typeof deckId !== "string" || deckId.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.MISSING_DECK_ID });
        return;
    }

    if (typeof instanceId !== "string" || instanceId.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.MISSING_INSTANCE_ID });
        return;
    }

    const userId = session.getUserId();
    const license = await KeyManagementService.getLicense(userId, deckId);

    if (!license)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ error: ErrorCodes.LICENSE_NOT_FOUND });
        return;
    }

    const database = await DatabaseConnector.getDatabase();

    // The library this copy's rows actually live in — the buyer's own for a
    // marketplace purchase, an organization's view for a deck it provided.
    const scopeKey = PaidDeckScopeResolver.resolveForLicense(license, userId);

    // Authoritative step: drop the copy from the license registry + bump
    // rotatedAt so the next /Sync/Licenses pull re-delivers the trimmed array.
    removeInstanceFromLicense(license, instanceId);
    license.setRotatedAt(new Date());

    try
    {
        await KeyManagementService.persistLicense(license);
    }
    catch (persistError)
    {
        console.error(`[DeletePaidDeckCopy] Failed to persist license for user ${userId} deck ${deckId}:`, persistError);
        response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
        response.sendJson({ error: ErrorCodes.INSTANCE_UPDATE_FAILED });
        return;
    }

    // Best-effort row teardown. Tombstone (so every other device converges even
    // if the client's deck.delete() never runs) + delete. bulkRecordDeletions
    // cascades from each instance-root deck to its cards / materials / mock
    // tests / popups by parent/deckId, which is naturally scoped to this copy.
    try
    {
        const instanceDeckRowFilter = buildPaidInstanceRowFilter(scopeKey, deckId, instanceId);
        const instanceDeckRows = await database
            .collection(DatabaseConstants.DECKS_COLLECTION)
            .find(instanceDeckRowFilter, { projection: { "data.id": 1, _id: 0 } })
            .toArray();

        const deletionChanges = instanceDeckRows
            .filter((row) => row?.data?.id)
            .map((row) => ({ entityId: row.data.id, entityType: entityTypes.DECK }));

        if (deletionChanges.length > 0)
        {
            await SyncQueryEngine.bulkRecordDeletions(scopeKey, database, deletionChanges);
        }
    }
    catch (teardownError)
    {
        // The license registry is already consistent and the client's own
        // deck.delete() will tear the rows down + propagate tombstones, so a
        // best-effort server teardown failure is non-fatal.
        console.warn(`[DeletePaidDeckCopy] Best-effort row teardown failed for user ${userId} deck ${deckId} copy ${instanceId}:`, teardownError);
    }

    response.statusCode = httpStatus.OK;
    response.sendJson({ success: true, license: LicenseClientView.sanitize(license.toJson()) });
}

module.exports = { deletePaidDeckCopy };
