const AdminListRegistry = require("../../../Globals/Classes/AdminLists/AdminListRegistry");
const AdminListQueryRunner = require("../../../Globals/Classes/AdminLists/AdminListQueryRunner");
const DatabaseConnector = require("../../../Globals/Classes/Database/DatabaseConnector");
const ErrorCodes = require("../../../Globals/Constants/ErrorCodes");
const { httpStatus } = require("../../../Globals/Enumerations/HttpStatus");

/**
 * POST /Admin/Lists/Query
 *
 * Returns one filtered / searched / sorted page of an admin list.
 *
 * Body: { listKey, search, filters, sort: { field, direction }, limit, offset, context }
 * Response: { items, totalCount, limit, offset }
 */
async function queryAdminList(request, response)
{
    const body = await request.getBody();
    const listKey = parseInt(body?.listKey, 10);

    if (isNaN(listKey))
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_REQUEST });
        return;
    }

    const definition = AdminListRegistry.getByKey(listKey);
    if (!definition)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ error: ErrorCodes.NOT_FOUND });
        return;
    }

    const database = await DatabaseConnector.getDatabase();
    if (!database)
    {
        response.statusCode = httpStatus.SERVICE_UNAVAILABLE;
        response.sendJson({ error: ErrorCodes.DATABASE_UNAVAILABLE });
        return;
    }

    const page = await AdminListQueryRunner.run(definition, database,
    {
        search: typeof body?.search === "string" ? body.search : "",
        filters: (body?.filters && typeof body.filters === "object") ? body.filters : {},
        sort: body?.sort || null,
        limit: body?.limit,
        offset: body?.offset,
        context: (body?.context && typeof body.context === "object") ? body.context : {}
    });

    response.statusCode = httpStatus.OK;
    response.sendJson(page);
}

module.exports = { queryAdminList };
