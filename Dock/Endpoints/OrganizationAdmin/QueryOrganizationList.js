const OrganizationAuthorityResolver = require("../../Globals/Classes/Organization/OrganizationAuthorityResolver");
const OrganizationMemberListBuilder = require("../../Globals/Classes/Organization/OrganizationMemberListBuilder");
const AdminListQueryRunner = require("../../Globals/Classes/AdminLists/AdminListQueryRunner");
const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");


/**
 * POST /Organization/Lists/Query
 *
 * Body: { organizationId, search, filters, sort, limit, offset }
 * Response: { items, totalCount, limit, offset }
 *
 * One filtered, searched, sorted page of an organization's member list, run by
 * the shared AdminListQueryRunner against MongoDB. The roster used to be pulled
 * whole and filtered in the browser, which meant every keystroke moved the
 * entire membership over the wire and paging was a lie.
 *
 * The organization scope is forced from the caller's resolved standing into the
 * definition's base query — which is not expressible as a filter — so no filter
 * payload can widen the query to another organization's members.
 */
async function queryOrganizationList(request, response)
{
    const body = await request.getBody();
    const organizationId = typeof body?.organizationId === "string" ? body.organizationId : "";

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

    const page = await AdminListQueryRunner.run(definition, database,
    {
        search: typeof body?.search === "string" ? body.search : "",
        filters: (body?.filters && typeof body.filters === "object") ? body.filters : {},
        sort: body?.sort || null,
        limit: body?.limit,
        offset: body?.offset
    });

    response.statusCode = httpStatus.OK;
    response.sendJson(page);
}

module.exports = { queryOrganizationList };
