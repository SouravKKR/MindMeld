const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");
const SyncQueryEngine = require("../../Globals/Classes/Database/SyncQueryEngine");
const OrganizationDeckQueryEngine = require("../../Globals/Classes/Organization/OrganizationDeckQueryEngine");
const PaidDeckScopeResolver = require("../../Globals/Classes/PaidDeck/PaidDeckScopeResolver");
const KeyManagementService = require("../../Globals/Classes/Security/KeyManagementService");
const { getUser } = require("../Helpers/GetUser");
const { entityTypes } = require("../../Globals/Enumerations/EntityTypes");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");


/**
 * POST /Organization/Decks/Remove
 *
 * Body: { organizationId, deckId }
 *
 * A member giving back a deck they took from the shelf. Revokes their own
 * licence and tombstones their copy, so every one of their devices drops it at
 * the next sync rather than one device keeping a local copy.
 *
 * Deliberately re-addable: this is "I do not need this right now", not a
 * refusal of the institute's material, and the shelf still offers it. The study
 * progress goes with the copy, which is stated in the client's confirmation —
 * the entities it was recorded against stop existing, so there is nothing for it
 * to be progress ON.
 *
 * Membership is NOT required here. Someone removed from an institute must still
 * be able to clear its content off their device, and refusing them would leave
 * material they can no longer study sitting in a library they cannot empty.
 */
async function removeOrganizationDeck(request, response)
{
    const body = await request.getBody();
    const organizationId = typeof body?.organizationId === "string" ? body.organizationId : "";
    const deckId = typeof body?.deckId === "string" ? body.deckId : "";

    const user = await getUser(request);
    if (!user)
    {
        response.sendStatusCode(httpStatus.UNAUTHORIZED);
        return;
    }

    // The deck has to be one this organization published, or a caller could
    // name any deck id and have their licence for it revoked through a route
    // that never checks what kind of deck it is.
    const paidDeck = await OrganizationDeckQueryEngine.getOrganizationDeck(organizationId, deckId);
    if (!paidDeck)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ success: false, error: ErrorCodes.PAID_DECK_NOT_FOUND });
        return;
    }

    const license = await KeyManagementService.getLicense(user.getId(), deckId);
    if (!license)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ success: false, error: ErrorCodes.LICENSE_NOT_FOUND });
        return;
    }

    const scopeKey = PaidDeckScopeResolver.resolveForLicense(license, user.getId());

    await KeyManagementService.revokeLicense(user.getId(), deckId);

    const database = await DatabaseConnector.getDatabase();
    const copyRootRows = await database
        .collection(DatabaseConstants.DECKS_COLLECTION)
        .find({ userId: scopeKey, "data.additionalData.paidDeckId": deckId }, { projection: { _id: 0, "data.id": 1 } })
        .toArray();

    const deletionChanges = copyRootRows
        .filter(row => row?.data?.id)
        .map(row => ({ entityId: row.data.id, entityType: entityTypes.DECK }));

    if (deletionChanges.length > 0)
    {
        // Cascades from each copy's root through its cards, study materials,
        // mock tests and overlays, tombstoning and removing them together.
        await SyncQueryEngine.bulkRecordDeletions(scopeKey, database, deletionChanges);
    }

    response.statusCode = httpStatus.OK;
    response.sendJson({ success: true, deckId: deckId, rootsRemoved: deletionChanges.length });
}

module.exports = { removeOrganizationDeck };
