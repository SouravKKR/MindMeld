const MaintenanceWindowStore = require("../../../Globals/Classes/Maintenance/MaintenanceWindowStore");
const MaintenanceWindow = require("../../../Globals/Model/MaintenanceWindow");
const { httpStatus } = require("../../../Globals/Enumerations/HttpStatus");

/**
 * POST /Admin/Maintenance/Add
 *
 * Body: { startDate: ISO string, endDate: ISO string, title?: string, message?: string }
 *
 * Creates a new maintenance window. Existing/in-flight tasks are never affected
 * — the window only blocks NEW work once it becomes active.
 */
async function addMaintenanceWindow(request, response)
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

    const startDate = body?.startDate ? new Date(body.startDate) : null;
    const endDate = body?.endDate ? new Date(body.endDate) : null;

    if (startDate === null || Number.isNaN(startDate.getTime()) || endDate === null || Number.isNaN(endDate.getTime()))
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: "Valid startDate and endDate are required." });
        return;
    }

    if (endDate.getTime() <= startDate.getTime())
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: "endDate must be after startDate." });
        return;
    }

    try
    {
        const window = new MaintenanceWindow({
            startDate: startDate,
            endDate: endDate,
            title: typeof body?.title === "string" ? body.title.trim() : undefined,
            message: typeof body?.message === "string" ? body.message : undefined,
            createdBy: requester.getId()
        });

        const saved = await MaintenanceWindowStore.add(window, requester.getId());
        response.sendJson({ ok: true, window: saved.toJson() });
    }
    catch (addError)
    {
        console.error(`[AddMaintenanceWindow] ${addError.message}`);
        response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
        response.sendJson({ error: "Failed to add maintenance window." });
    }
}

module.exports = { addMaintenanceWindow };
