const MaintenanceWindowStore = require("../../../Globals/Classes/Maintenance/MaintenanceWindowStore");
const { httpStatus } = require("../../../Globals/Enumerations/HttpStatus");

/**
 * POST /Admin/Maintenance/Update
 *
 * Body: { id: string, updates: { startDate?, endDate?, title?, message? } }
 *
 * Patches an existing window. Validates that the resulting window still has
 * end after start.
 */
async function updateMaintenanceWindow(request, response)
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
    const updates = body?.updates && typeof body.updates === "object" ? body.updates : null;

    if (id.length === 0 || updates === null)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: "id and updates are required." });
        return;
    }

    // Validate any supplied dates before touching the store.
    const proposedStart = updates.startDate !== undefined ? new Date(updates.startDate) : null;
    const proposedEnd = updates.endDate !== undefined ? new Date(updates.endDate) : null;

    if (proposedStart !== null && Number.isNaN(proposedStart.getTime()))
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: "startDate is invalid." });
        return;
    }
    if (proposedEnd !== null && Number.isNaN(proposedEnd.getTime()))
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: "endDate is invalid." });
        return;
    }
    try
    {
        // Validate the EFFECTIVE window (existing dates merged with the proposed
        // ones) BEFORE persisting, so a one-sided edit that crosses the other
        // boundary is rejected without ever writing a bad document.
        const existingWindows = await MaintenanceWindowStore.list();
        const existingWindow = existingWindows.find(window => window.getId() === id) || null;

        if (existingWindow === null)
        {
            response.statusCode = httpStatus.NOT_FOUND;
            response.sendJson({ error: "Maintenance window not found." });
            return;
        }

        const effectiveStart = proposedStart !== null ? proposedStart : existingWindow.getStartDate();
        const effectiveEnd = proposedEnd !== null ? proposedEnd : existingWindow.getEndDate();

        if (effectiveStart && effectiveEnd && effectiveEnd.getTime() <= effectiveStart.getTime())
        {
            response.statusCode = httpStatus.BAD_REQUEST;
            response.sendJson({ error: "endDate must be after startDate." });
            return;
        }

        const window = await MaintenanceWindowStore.update(id, updates, requester.getId());

        if (window === null)
        {
            response.statusCode = httpStatus.NOT_FOUND;
            response.sendJson({ error: "Maintenance window not found." });
            return;
        }

        response.sendJson({ ok: true, window: window.toJson() });
    }
    catch (updateError)
    {
        console.error(`[UpdateMaintenanceWindow] ${updateError.message}`);
        response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
        response.sendJson({ error: "Failed to update maintenance window." });
    }
}

module.exports = { updateMaintenanceWindow };
