const OrganizationMemberQueryEngine = require("../../Globals/Classes/Organization/OrganizationMemberQueryEngine");
const OrganizationMemberProfileMutator = require("../../Globals/Classes/Organization/OrganizationMemberProfileMutator");
const OrganizationMemberColumnBackfiller = require("../../Globals/Classes/Organization/OrganizationMemberColumnBackfiller");
const OrganizationAuthorityResolver = require("../../Globals/Classes/Organization/OrganizationAuthorityResolver");
const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const { organizationDelegatePowers } = require("../../Globals/Enumerations/OrganizationDelegatePowers");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");

// One page of a roster is the realistic size of a hand-checked selection, and
// the ceiling keeps a crafted payload from turning one request into an
// unbounded write. Selecting a whole cohort is what the by-filter route is for.
const MAXIMUM_SELECTED_MEMBERS = 500;


/**
 * POST /Organization/Members/BulkUpdate
 *
 * Body: { organizationId, memberIds[], addTags?, removeTags?, replaceTags?,
 *         setAttributes?, clearAttributeKeys? }
 *
 * Applies one change to everybody the administrator checked.
 *
 * Tag changes are expressed as add / remove rather than as a replacement,
 * because a selection is a set of people who differ: replacing the tag list
 * across twelve members would strip whatever each of them carried that the
 * others did not. Replacement stays available, but only as an explicit choice.
 *
 * An empty mutation is refused. "Change nothing about these 40 people" is a
 * request that meant to say something and did not, and answering it with
 * "40 members updated" would be false.
 */
async function bulkUpdateOrganizationMembers(request, response)
{
    const body = await request.getBody();
    const organizationId = typeof body?.organizationId === "string" ? body.organizationId : "";
    const memberIds = Array.isArray(body?.memberIds) ? body.memberIds : [];

    if (memberIds.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: ErrorCodes.MISSING_MEMBER_IDS });
        return;
    }

    if (memberIds.length > MAXIMUM_SELECTED_MEMBERS)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: ErrorCodes.TOO_MANY_SELECTED_MEMBERS });
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
        addTags: body?.addTags,
        removeTags: body?.removeTags,
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

    if (OrganizationMemberProfileMutator.isMutationEmpty(mutation))
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: ErrorCodes.INVALID_REQUEST });
        return;
    }

    const updateResult = await OrganizationMemberQueryEngine.applyMutationToMemberIds(organizationId, memberIds, mutation);

    const database = await DatabaseConnector.getDatabase();
    if (database)
    {
        await OrganizationMemberColumnBackfiller.backfillForOrganization(database, organizationId);
    }

    response.statusCode = httpStatus.OK;
    response.sendJson
    ({
        success: true,
        summary:
        {
            requested: memberIds.length,
            matched: updateResult.matchedCount,
            updated: updateResult.updated
        }
    });
}

module.exports = { bulkUpdateOrganizationMembers };
