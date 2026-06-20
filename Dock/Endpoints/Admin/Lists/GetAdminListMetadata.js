const AdminListRegistry = require("../../../Globals/Classes/AdminLists/AdminListRegistry");
const DatabaseConnector = require("../../../Globals/Classes/Database/DatabaseConnector");
const ErrorCodes = require("../../../Globals/Constants/ErrorCodes");
const { httpStatus } = require("../../../Globals/Enumerations/HttpStatus");

/**
 * GET /Admin/Lists/Metadata?listKey=<number>
 *
 * Returns the render metadata for one admin list: searchable flag, filter
 * definitions, columns, default sort, and limit options. The client builds the
 * table, search box, and filter inputs purely from this — no list-specific
 * client code.
 */
async function getAdminListMetadata(request, response)
{
    const queryParams = await request.getQueryParams();
    const listKey = parseInt(queryParams.listKey, 10);

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
    const metadata = await definition.getMetadata(database);

    response.statusCode = httpStatus.OK;
    response.sendJson(metadata);
}

module.exports = { getAdminListMetadata };
