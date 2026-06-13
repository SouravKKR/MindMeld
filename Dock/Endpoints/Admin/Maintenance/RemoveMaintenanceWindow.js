const MaintenanceWindowStore = require("../../../Globals/Classes/Maintenance/MaintenanceWindowStore");
const { httpStatus } = require("../../../Globals/Enumerations/HttpStatus");

/**
 * POST /Admin/Maintenance/Remove
 *
 * Body: { id: string }
 *
 * Removes a scheduled maintenance window.
 */
async function removeMaintenanceWindow(request, response)
{
    const requester = request.user;
    if (!requester)
    {
        response.sendStatusCode(httpStatus.UNAUTHORIZED);
        return;
    }

    let body;
    try
    {
        body = await request.getBody();
    }
    catch (bodyError)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: "Malformed JSON body." });
        return;
    }

    const id = typeof body?.id === "string" ? body.id.trim() : "";
    if (id.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: "id is required." });
        return;
    }

    try
    {
        const removed = await MaintenanceWindowStore.remove(id);
        if (!removed)
        {
            response.statusCode = httpStatus.NOT_FOUND;
            response.sendJson({ error: "Maintenance window not found." });
            return;
        }
        response.sendJson({ ok: true });
    }
    catch (removeError)
    {
        console.error(`[RemoveMaintenanceWindow] ${removeError.message}`);
        response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
        response.sendJson({ error: "Failed to remove maintenance window." });
    }
}

module.exports = { removeMaintenanceWindow };
