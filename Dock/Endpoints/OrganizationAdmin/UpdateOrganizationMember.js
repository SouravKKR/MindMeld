const OrganizationMemberQueryEngine = require("../../Globals/Classes/Organization/OrganizationMemberQueryEngine");
const OrganizationMemberProfileMutator = require("../../Globals/Classes/Organization/OrganizationMemberProfileMutator");
const OrganizationMemberColumnBackfiller = require("../../Globals/Classes/Organization/OrganizationMemberColumnBackfiller");
const OrganizationAuthorityResolver = require("../../Globals/Classes/Organization/OrganizationAuthorityResolver");
const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const { organizationDelegatePowers } = require("../../Globals/Enumerations/OrganizationDelegatePowers");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");


/**
 * POST /Organization/Members/Update
 *
 * Body: { organizationId, memberId, replaceTags?, setAttributes?, clearAttributeKeys? }
 *
 * Corrects ONE member. Before this existed the only way to change a tag or a
 * column value was to re-upload the entire roster, which meant fixing one
 * person's spelling required a spreadsheet and risked rewriting everybody else.
 *
 * The edit is applied through the shared mutator, so the three stored copies of
 * every attribute are re-derived together — the alternative, writing
 * `attributes` alone, leaves the range filters matching the value that was just
 * corrected.
 *
 * Any column the edit introduces is added to the organization's schema
 * afterwards, so a value typed here behaves exactly like one that arrived on a
 * sheet: filterable, nameable, and available to a rule.
 */
async function updateOrganizationMember(request, response)
{
    const body = await request.getBody();
    const organizationId = typeof body?.organizationId === "string" ? body.organizationId : "";
    const memberId = typeof body?.memberId === "string" ? body.memberId : "";

    if (memberId.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: ErrorCodes.MEMBER_NOT_FOUND });
        return;
    }

    const authority = await OrganizationAuthorityResolver.requirePower(request.user, organizationId, organizationDelegatePowers.MANAGE_MEMBERS);
    if (!authority.allowed)
    {
        response.statusCode = OrganizationAuthorityResolver.statusForDenial(authority);
        response.sendJson({ success: false, error: authority.reason });
        return;
    }

    const mutation =
    {
        replaceTags: body?.replaceTags,
        setAttributes: body?.setAttributes,
        clearAttributeKeys: body?.clearAttributeKeys
    };

    const validation = OrganizationMemberProfileMutator.validateMutation(mutation);
    if (!validation.valid)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: validation.reason });
        return;
    }

    const updateResult = await OrganizationMemberQueryEngine.applyMutationToMemberIds(organizationId, [memberId], mutation);
    if (updateResult.matchedCount === 0)
    {
        // Scoped by organization as well as by id, so a member id belonging to
        // another institute reads as "not here" rather than being edited.
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ success: false, error: ErrorCodes.MEMBER_NOT_FOUND });
        return;
    }

    const database = await DatabaseConnector.getDatabase();
    if (database)
    {
        await OrganizationMemberColumnBackfiller.backfillForOrganization(database, organizationId);
    }

    response.statusCode = httpStatus.OK;
    response.sendJson({ success: true, updated: updateResult.updated });
}

module.exports = { updateOrganizationMember };
