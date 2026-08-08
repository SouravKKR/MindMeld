const OrganizationAuthorityResolver = require("../../Globals/Classes/Organization/OrganizationAuthorityResolver");
const OrganizationMemberListBuilder = require("../../Globals/Classes/Organization/OrganizationMemberListBuilder");
const OrganizationMemberQueryEngine = require("../../Globals/Classes/Organization/OrganizationMemberQueryEngine");
const OrganizationMemberProfileMutator = require("../../Globals/Classes/Organization/OrganizationMemberProfileMutator");
const OrganizationMemberColumnBackfiller = require("../../Globals/Classes/Organization/OrganizationMemberColumnBackfiller");
const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const { organizationDelegatePowers } = require("../../Globals/Enumerations/OrganizationDelegatePowers");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");

// How many matched members to name back in a dry run. Enough to recognise the
// selection, few enough that the response stays small for a 500-person match.
const PREVIEW_SAMPLE_SIZE = 10;

// A whole roster in one request. An organization is seat-capped well below this,
// so it bounds the write without standing between an institute and its own
// members.
const MAXIMUM_AFFECTED_MEMBERS = 5000;


/**
 * POST /Organization/Members/UpdateByFilter
 *
 * Body: { organizationId, search?, filters?, dryRun?, addTags?, removeTags?,
 *         replaceTags?, setAttributes?, clearAttributeKeys? }
 *
 * Applies one change to everyone matching the SAME filter expression the member
 * list is showing — "tag every first-year with roll numbers A0100 to A0450" —
 * rather than to a hand-collected list of ids.
 *
 * This route is not a convenience. The roster list discards its checkbox
 * selection when the page changes, so selecting people is bounded by what fits
 * on screen; without a filter-scoped path, tagging a 400-strong cohort would
 * mean forty separate passes. The filters and the search string go through the
 * same builder the list uses, so what was on screen and what is changed cannot
 * mean different things.
 *
 * `dryRun: true` returns the count and a sample and changes nothing. The client
 * runs it first and puts the real number in the confirmation, because the whole
 * risk of editing-by-filter is that a filter matches more people than the person
 * writing it expects.
 *
 * An empty filter is REFUSED, matching removal-by-filter: "apply this to
 * everyone who matches no criteria" is how a whole roster is rewritten by
 * accident.
 */
async function updateOrganizationMembersByFilter(request, response)
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

    // Checked even for a dry run: previewing a change that would be refused on
    // apply tells the administrator the opposite of the truth.
    if (OrganizationMemberProfileMutator.isMutationEmpty(mutation))
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: ErrorCodes.INVALID_REQUEST });
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

    const updateResult = await OrganizationMemberQueryEngine.applyMutationToMembersMatching
    (
        organizationId,
        filterQuery,
        mutation,
        MAXIMUM_AFFECTED_MEMBERS
    );

    await OrganizationMemberColumnBackfiller.backfillForOrganization(database, organizationId);

    response.statusCode = httpStatus.OK;
    response.sendJson
    ({
        success: true,
        dryRun: false,
        matchedCount: updateResult.matchedCount,
        updated: updateResult.updated,
        // Surfaced rather than swallowed: an administrator who asked to change a
        // cohort larger than one request may carry must be told some of it was
        // left alone, not shown a success that silently covered part of it.
        truncated: updateResult.truncated
    });
}

module.exports = { updateOrganizationMembersByFilter };
