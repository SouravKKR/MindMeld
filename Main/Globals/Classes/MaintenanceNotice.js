import DialogBox from "../../CommonComponents/DialogBox.js";

/**
 * Shared user-facing presentation for the scheduled-maintenance block. Keeps the
 * "maintenance is going on, check back at <time>" message identical across every
 * task-starting call site (generation, AskAi, analysis, mock-test grading) so a
 * 503 MAINTENANCE_ACTIVE response surfaces as one friendly dialog.
 */
class MaintenanceNotice
{
    static MAINTENANCE_ACTIVE_ERROR = "MAINTENANCE_ACTIVE";

    /**
     * If the response is a 503 maintenance block, shows the dialog and returns
     * true (the caller should stop). Otherwise returns false so the caller's
     * normal handling continues. Safe to call before other status checks.
     * @param {Response} response
     * @returns {Promise<boolean>}
     */
    static async handleIfMaintenance(response)
    {
        if (!response || response.status !== 503)
        {
            return false;
        }

        const detail = await response.clone().json().catch(() => ({}));
        if (!detail || detail.error !== MaintenanceNotice.MAINTENANCE_ACTIVE_ERROR)
        {
            return false;
        }

        await MaintenanceNotice.show(detail);
        return true;
    }

    /**
     * @param {{ endTimestamp?: string|null, message?: string }} detail
     */
    static async show(detail = {})
    {
        let message = "Maintenance is currently going on, so new AI tasks are paused.";

        if (detail && detail.endTimestamp)
        {
            const endDate = new Date(detail.endTimestamp);
            if (!Number.isNaN(endDate.getTime()))
            {
                message += ` Please check back at ${endDate.toLocaleString()}.`;
            }
        }

        if (detail && typeof detail.message === "string" && detail.message.trim().length > 0)
        {
            message += ` ${detail.message.trim()}`;
        }

        await DialogBox.alert("Maintenance in progress", message);
    }
}

export default MaintenanceNotice;
