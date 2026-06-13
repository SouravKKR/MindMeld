const MaintenanceWindowStore = require("../../../Globals/Classes/Maintenance/MaintenanceWindowStore");
const { httpStatus } = require("../../../Globals/Enumerations/HttpStatus");

/**
 * GET /Admin/Maintenance/List
 *
 * Returns every scheduled maintenance window for the admin tab.
 */
async function listMaintenanceWindows(request, response)
{
    const requester = request.user;
    if (!requester)
    {
        response.sendStatusCode(httpStatus.UNAUTHORIZED);
        return;
    }

    try
    {
        const windows = await MaintenanceWindowStore.list();
        response.sendJson({ windows: windows.map(window => window.toJson()) });
    }
    catch (listError)
    {
        console.error(`[ListMaintenanceWindows] ${listError.message}`);
        response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
        response.sendJson({ error: "Failed to load maintenance windows." });
    }
}

module.exports = { listMaintenanceWindows };
