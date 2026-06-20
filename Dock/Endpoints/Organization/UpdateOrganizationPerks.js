const OrganizationQueryEngine = require("../../Globals/Classes/Organization/OrganizationQueryEngine");
const OrganizationDeckPerkQueryEngine = require("../../Globals/Classes/Organization/OrganizationDeckPerkQueryEngine");
const OrganizationAutoAssigner = require("../../Globals/Classes/Organization/OrganizationAutoAssigner");
const { organizationStatus } = require("../../Globals/Enumerations/OrganizationStatus");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");


async function updateOrganizationPerks(request, response)
{
    const body = await request.getBody();
    const organizationId = typeof body?.organizationId === "string" ? body.organizationId : "";
    const perks = Array.isArray(body?.perks) ? body.perks : [];

    if (!organizationId)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: ErrorCodes.MISSING_ORGANIZATION_ID });
        return;
    }

    const organization = await OrganizationQueryEngine.getOrganizationById(organizationId);
    if (!organization)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ success: false, error: ErrorCodes.ORG_NOT_FOUND });
        return;
    }
    if (organization.getStatus() !== organizationStatus.ACTIVE)
    {
        response.statusCode = httpStatus.CONFLICT;
        response.sendJson({ success: false, error: ErrorCodes.ORG_NOT_ACTIVE });
        return;
    }

    for (const perkInput of perks)
    {
        const validation = OrganizationDeckPerkQueryEngine.validatePerk(perkInput);
        if (!validation.valid)
        {
            response.statusCode = httpStatus.BAD_REQUEST;
            response.sendJson({ success: false, error: ErrorCodes.INVALID_PERK, reason: validation.reason, deckId: perkInput?.deckId });
            return;
        }
    }

    const replaceResult = await OrganizationDeckPerkQueryEngine.replacePerks(organizationId, perks);

    // Fan FREE perks out to existing members + admin. The query engine
    // returns only newly-FREE perks so re-saving the same perk set is a
    // no-op for already-granted decks.
    let totalAutoAssigned = 0;
    for (const freePerk of replaceResult.freeDeckIds)
    {
        const propagateResult = await OrganizationAutoAssigner.propagateNewFreePerk
        (
            organizationId,
            freePerk.deckId,
            freePerk.durationDays
        );
        totalAutoAssigned += propagateResult.granted;
    }

    response.statusCode = httpStatus.OK;
    response.sendJson
    ({
        success: true,
        organizationId: organizationId,
        replaced: replaceResult.replaced,
        autoAssignedDecks: totalAutoAssigned
    });
}

module.exports = { updateOrganizationPerks };
