const OrganizationAuthorityResolver = require("../../../Globals/Classes/Organization/OrganizationAuthorityResolver");
const OrganizationDeckWithdrawalService = require("../../../Globals/Classes/Organization/OrganizationDeckWithdrawalService");
const { organizationDelegatePowers } = require("../../../Globals/Enumerations/OrganizationDelegatePowers");
const { httpStatus } = require("../../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../../Globals/Constants/ErrorCodes");


/**
 * POST /Organization/PaidDecks/Withdraw
 *
 * Body: { organizationId, deckId }
 *
 * Takes the deck back from every member holding it: unpublished first so nobody
 * new can add it mid-withdrawal, then each holder's licence revoked and their
 * copy tombstoned so all of their devices converge on the removal at their next
 * sync.
 *
 * The master content is kept. Withdrawal is "stop providing this", not "destroy
 * it" — an institute that withdraws a deck to correct an error must be able to
 * re-publish the corrected version rather than start again.
 */
async function withdrawOrganizationDeck(request, response)
{
    const body = await request.getBody();
    const organizationId = typeof body?.organizationId === "string" ? body.organizationId : "";
    const deckId = typeof body?.deckId === "string" ? body.deckId : "";

    const authority = await OrganizationAuthorityResolver.requirePower(request.user, organizationId, organizationDelegatePowers.PUBLISH_DECKS);
    if (!authority.allowed)
    {
        response.statusCode = OrganizationAuthorityResolver.statusForDenial(authority);
        response.sendJson({ success: false, error: authority.reason });
        return;
    }

    const withdrawalResult = await OrganizationDeckWithdrawalService.withdraw(organizationId, deckId);

    if (!withdrawalResult.withdrawn)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ success: false, error: ErrorCodes.PAID_DECK_NOT_FOUND });
        return;
    }

    response.statusCode = httpStatus.OK;
    response.sendJson
    ({
        success: true,
        deckId: deckId,
        licensesRevoked: withdrawalResult.licensesRevoked,
        membersAffected: withdrawalResult.membersAffected,
        rootsTombstoned: withdrawalResult.rootsTombstoned
    });
}

module.exports = { withdrawOrganizationDeck };
