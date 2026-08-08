const OrganizationAuthorityResolver = require("../../../Globals/Classes/Organization/OrganizationAuthorityResolver");
const OrganizationMemberColumnQueryEngine = require("../../../Globals/Classes/Organization/OrganizationMemberColumnQueryEngine");
const OrganizationMemberColumnBackfiller = require("../../../Globals/Classes/Organization/OrganizationMemberColumnBackfiller");
const DatabaseConnector = require("../../../Globals/Classes/Database/DatabaseConnector");
const {httpStatus} = require("../../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../../Globals/Constants/ErrorCodes");


/**
 * GET /Organization/Members/Columns/List?organizationId=...
 *
 * The columns this organization keeps about its members.
 *
 * The backfill runs first, so an institute whose roster was imported before
 * columns existed opens the editor and finds its own columns already described
 * rather than an empty screen with a migration nobody was told to run.
 *
 * Readable by anyone with standing in the organization — knowing what the
 * columns are called is needed to read the roster at all — while changing them
 * requires MANAGE_MEMBERS.
 */
async function listOrganizationMemberColumns(request, response)
{
    const queryParams = await request.getQueryParams();
    const organizationId = typeof queryParams?.organizationId === "string" ? queryParams.organizationId : "";

    const authority = await OrganizationAuthorityResolver.resolve(request.user, organizationId);
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

    await OrganizationMemberColumnBackfiller.backfillForOrganization(database, organizationId);
    const columns = await OrganizationMemberColumnQueryEngine.listColumnsForOrganization(organizationId);

    response.statusCode = httpStatus.OK;
    response.sendJson
    ({
        success: true,
        columns: columns.map(column => column.toJson()),
        reservedKey: OrganizationMemberColumnQueryEngine.RESERVED_COLUMN_KEY,
        maximumColumns: OrganizationMemberColumnQueryEngine.MAXIMUM_COLUMNS_PER_ORGANIZATION
    });
}

module.exports = { listOrganizationMemberColumns };
