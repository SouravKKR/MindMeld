const MaintenanceWindowStore = require("../../Globals/Classes/Maintenance/MaintenanceWindowStore");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");

// How far ahead an upcoming window is surfaced to users for advance notice.
function resolveNoticeLeadMilliseconds()
{
    const rawValue = process.env.MAINTENANCE_NOTICE_LEAD_HOURS;
    const parsedValue = Number(rawValue);
    const hours = Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : 24;
    return hours * 60 * 60 * 1000;
}

/**
 * GET /Maintenance/Status
 *
 * Returns the currently-active window (if any) plus any windows starting within
 * the advance-notice lead, so the frontend can warn users ahead of time and show
 * the "check back at <time>" banner during downtime.
 */
async function getMaintenanceStatus(request, response)
{
    try
    {
        const now = new Date();
        const activeWindow = await MaintenanceWindowStore.getActiveWindow(now);
        const upcomingWindows = await MaintenanceWindowStore.getUpcomingWindows(now, resolveNoticeLeadMilliseconds());

        response.sendJson({
            active: activeWindow ? activeWindow.toJson() : null,
            upcoming: upcomingWindows.map(window => window.toJson())
        });
    }
    catch (statusError)
    {
        console.error(`[GetMaintenanceStatus] ${statusError.message}`);
        // Fail open: report no maintenance rather than blocking the client UI.
        response.statusCode = httpStatus.OK;
        response.sendJson({ active: null, upcoming: [] });
    }
}

module.exports = { getMaintenanceStatus };
