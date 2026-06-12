const AlertQueryEngine = require("../../../Globals/Classes/Database/AlertQueryEngine");
const {httpStatus} = require("../../../Globals/Enumerations/HttpStatus");

/**
 * GET /Admin/Alerts/List
 *
 * Query params (all optional):
 *   onlyUnacknowledged=true  — hide acknowledged (closed) rows
 *   since=<ISO>              — only rows whose lastSeenAt is newer (notifier poll)
 *   limit=<n>
 */
async function listAlerts(request, response)
{
    const query = (await request.getQueryParams()) || {};
    const onlyUnacknowledged = String(query.onlyUnacknowledged) === "true";
    const since = typeof query.since === "string" && query.since.length > 0 ? query.since : null;
    const limit = query.limit !== undefined ? Number(query.limit) : undefined;

    try
    {
        const alerts = await AlertQueryEngine.list({ onlyUnacknowledged, since, limit });
        response.statusCode = httpStatus.OK;
        response.sendJson({ alerts });
    }
    catch (listError)
    {
        console.error(`[ListAlerts] ${listError.message}`);
        response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
        response.sendJson({ error: "Failed to list alerts." });
    }
}

module.exports = { listAlerts };
