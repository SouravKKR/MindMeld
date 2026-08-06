const OrganizationAuthorityResolver = require("../../Globals/Classes/Organization/OrganizationAuthorityResolver");
const OrganizationMemberListBuilder = require("../../Globals/Classes/Organization/OrganizationMemberListBuilder");
const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");


/**
 * GET /Organization/Lists/Metadata?organizationId=...
 *
 * The render metadata for one organization's member list: its columns, its
 * sortable fields, and the filter set built from the attribute keys and tags
 * that organization actually uses.
 *
 * This exists rather than reusing /Admin/Lists/Metadata because that route is
 * super-admin-only and takes the list scope from the caller. Here the scope is
 * resolved from the caller's standing, so an organization admin can only ever
 * describe their own roster.
 */
async function getOrganizationListMetadata(request, response)
{
    const queryParams = await request.getQueryParams();
    const organizationId = typeof queryParams?.organizationId === "string" ? queryParams.organizationId : "";

    const authority = await OrganizationAuthorityResolver.resolve(request.user, organizationId);
    if (!authority.allowed)
    {
        response.statusCode = OrganizationAuthorityResolver.statusForDenial(authority);
        response.sendJson({ error: authority.reason });
        return;
    }

    const database = await DatabaseConnector.getDatabase();
    if (!database)
    {
        response.statusCode = httpStatus.SERVICE_UNAVAILABLE;
        response.sendJson({ error: ErrorCodes.DATABASE_UNAVAILABLE });
        return;
    }

    const { definition } = await OrganizationMemberListBuilder.build(database, organizationId);
    const metadata = await definition.getMetadata(database);

    response.statusCode = httpStatus.OK;
    response.sendJson(metadata);
}

module.exports = { getOrganizationListMetadata };
