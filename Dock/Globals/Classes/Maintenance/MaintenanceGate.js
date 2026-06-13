const MaintenanceWindowStore = require("./MaintenanceWindowStore");

// Central decision point for "may a new agent task start right now?". Called at
// the ENTRY of every endpoint that starts new agent work (generation + AskAi).
// It must NOT be called from inside the task DAG walk — in-flight work must never
// be disrupted by a window that opens mid-pipeline.
//
// Never throws into the caller: a maintenance-subsystem fault must not take down
// the request path, so a lookup failure fails OPEN (work is allowed).

class MaintenanceGate
{
    // Shared error code so the client and server agree without a magic string.
    static MAINTENANCE_ACTIVE_ERROR_CODE = "MAINTENANCE_ACTIVE";

    /**
     * @returns {Promise<import('../../Model/MaintenanceWindow')|null>} The active window, or null.
     */
    static async getActiveWindow()
    {
        try
        {
            return await MaintenanceWindowStore.getActiveWindow(new Date());
        }
        catch (lookupError)
        {
            console.error("[MaintenanceGate] Active-window lookup failed; failing open:", lookupError);
            return null;
        }
    }

    /**
     * @returns {Promise<boolean>}
     */
    static async isMaintenanceActiveNow()
    {
        return (await MaintenanceGate.getActiveWindow()) !== null;
    }

    /**
     * Builds the structured 503 body the client uses to show the
     * "check back at <time>" alert.
     * @param {import('../../Model/MaintenanceWindow')} window
     * @returns {{error: string, endTimestamp: string|null, message: string, title: string}}
     */
    static buildMaintenanceResponsePayload(window)
    {
        const endDate = window ? window.getEndDate() : null;
        return {
            error: MaintenanceGate.MAINTENANCE_ACTIVE_ERROR_CODE,
            endTimestamp: endDate ? endDate.toISOString() : null,
            title: window ? window.getTitle() : "Scheduled maintenance",
            message: window ? window.getMessage() : ""
        };
    }
}

module.exports = MaintenanceGate;
