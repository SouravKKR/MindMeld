const OrganizationAuthorityResolver = require("../../Globals/Classes/Organization/OrganizationAuthorityResolver");
const OrganizationMemberListBuilder = require("../../Globals/Classes/Organization/OrganizationMemberListBuilder");
const OrganizationMemberQueryEngine = require("../../Globals/Classes/Organization/OrganizationMemberQueryEngine");
const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const { organizationDelegatePowers } = require("../../Globals/Enumerations/OrganizationDelegatePowers");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");

// How many matched members to name back in a dry run. Enough to recognise the
// selection, few enough that the response stays small for a 500-person match.
const PREVIEW_SAMPLE_SIZE = 10;


/**
 * POST /Organization/Members/RemoveByFilter
 *
 * Body: { organizationId, search?, filters?, dryRun? }
 *
 * Removes everyone matching the SAME filter expression the member list is
 * showing — "every first-year with roll numbers A0100 to A0450", not a
 * hand-collected list of ids. The filters and the search string are passed
 * through the same builder the list uses, so what was on screen and what is
 * deleted cannot mean different things.
 *
 * `dryRun: true` returns the count and a sample and deletes nothing. The client
 * runs it first and puts the real number in the confirmation, because the whole
 * risk of removal-by-filter is that a filter matches more people than the
 * person writing it expects.
 *
 * An empty filter is REFUSED. "Remove everyone who matches no criteria" is how
 * an entire roster disappears by accident, and a bulk delete is not the place
 * to be permissive about intent.
 */
async function removeOrganizationMembersByFilter(request, response)
{
    const body = await request.getBody();
    const organizationId = typeof body?.organizationId === "string" ? body.organizationId : "";
    const bDryRun = body?.dryRun === true;

    const authority = await OrganizationAuthorityResolver.requirePower(request.user, organizationId, organizationDelegatePowers.MANAGE_MEMBERS);
    if (!authority.allowed)
    {
        response.statusCode = OrganizationAuthorityResolver.statusForDenial(authority);
        response.sendJson({ success: false, error: authority.reason });
        return;
    }

    const database = await DatabaseConnector.getDatabase();
    if (!database)
    {
        response.statusCode = httpStatus.SERVICE_UNAVAILABLE;
        response.sendJson({ success: false, error: ErrorCodes.DATABASE_UNAVAILABLE });
        return;
    }

    const { definition } = await OrganizationMemberListBuilder.build(database, organizationId);
    const filterQuery = OrganizationMemberListBuilder.buildFilterQuery
    (
        definition,
        (body?.filters && typeof body.filters === "object") ? body.filters : {},
        typeof body?.search === "string" ? body.search : ""
    );

    if (OrganizationMemberListBuilder.isFilterQueryEmpty(filterQuery))
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: ErrorCodes.EMPTY_FILTER });
        return;
    }

    if (bDryRun)
    {
        const preview = await OrganizationMemberQueryEngine.previewMembersMatching(organizationId, filterQuery, PREVIEW_SAMPLE_SIZE);
        response.statusCode = httpStatus.OK;
        response.sendJson
        ({
            success: true,
            dryRun: true,
            matchedCount: preview.matchedCount,
            sample: preview.sample.map(member => ({ email: member.getEmail(), tags: member.getTags() }))
        });
        return;
    }

    const removeResult = await OrganizationMemberQueryEngine.removeMembersMatching(organizationId, filterQuery);

    response.statusCode = httpStatus.OK;
    response.sendJson({ success: true, dryRun: false, removed: removeResult.removed });
}

module.exports = { removeOrganizationMembersByFilter };
