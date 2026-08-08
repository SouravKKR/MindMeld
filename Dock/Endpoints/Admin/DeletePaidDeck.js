const PaidDeckRetirementService = require("../../Globals/Classes/PaidDeck/PaidDeckRetirementService");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");

/**
 * POST /Admin/PaidDecks/Delete  (super-admin)
 *
 * Body: { deckId, bForceDeleteWithActiveHolders? }
 *
 * Destroys the listing and its encrypted master content, along with the pricing
 * rows, organization perks and bundle references that pointed at it.
 *
 * Refused by default while anybody still holds an active licence. The normal
 * route for a deck people own is Retire: withdraw it, let the finite licences
 * run out, then delete.
 *
 * bForceDeleteWithActiveHolders is the deliberate override, and it is not a
 * flag the ordinary Delete button sets — the admin panel asks a second time,
 * naming how many people it affects, before it is ever sent. Forcing revokes
 * every active licence in the same operation: a holder left with an
 * entitlement pointing at deleted content would see a deck they own simply
 * fail to open. Anyone who had already downloaded it keeps their own copy;
 * anyone who had not loses it permanently.
 *
 * The route is behind ensureAdmin, so AdminActionAuditor already records who
 * called it and what came back; the revoked count is returned so the response
 * itself says what it cost.
 */
async function deletePaidDeck(request, response)
{
    const body = await request.getBody();
    const deckId = typeof body?.deckId === "string" ? body.deckId : "";
    const bForceDeleteWithActiveHolders = body?.bForceDeleteWithActiveHolders === true;

    if (deckId.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.MISSING_DECK_ID });
        return;
    }

    const deletionResult = await PaidDeckRetirementService.deletePermanently(
        deckId,
        request.user?.getId() || "",
        bForceDeleteWithActiveHolders,
    );

    if (!deletionResult.success)
    {
        if (deletionResult.error === ErrorCodes.PAID_DECK_NOT_FOUND)
        {
            response.statusCode = httpStatus.NOT_FOUND;
            response.sendJson({ error: deletionResult.error });
            return;
        }

        response.statusCode = deletionResult.error === ErrorCodes.PAID_DECK_STILL_HELD
            ? httpStatus.CONFLICT
            : httpStatus.INTERNAL_SERVER_ERROR;
        response.sendJson({ error: deletionResult.error, holders: deletionResult.holders });
        return;
    }

    response.statusCode = httpStatus.OK;
    response.sendJson
    ({
        success: true,
        deckId: deckId,
        // Returned so the caller can say what actually happened rather than a
        // flat "deleted" — an administrator who just took a deck from eleven
        // people should be told it was eleven.
        revokedLicenseCount: deletionResult.revokedLicenseCount || 0,
    });
}

module.exports = { deletePaidDeck };
