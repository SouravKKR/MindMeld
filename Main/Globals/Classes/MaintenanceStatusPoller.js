import MaintenanceEvents from "../Events/MaintenanceEvents.js";

/**
 * MaintenanceStatusPoller
 *
 * Polls /Maintenance/Status on an interval and broadcasts the result via a
 * window CustomEvent so the maintenance banner (and anything else interested)
 * can react. Mirrors the AlertNotifier polling pattern: static class, idempotent
 * start()/stop(), an immediate poll on start, and a remembered last status so a
 * freshly-mounted banner can render without waiting for the next tick.
 */
class MaintenanceStatusPoller
{
    static #STATUS_ENDPOINT = "/Maintenance/Status";
    static #POLL_INTERVAL_MILLISECONDS = 5 * 60 * 1000;

    static #intervalHandle = null;
    static #lastStatus = null;

    static start()
    {
        if (MaintenanceStatusPoller.#intervalHandle !== null)
        {
            return;
        }

        MaintenanceStatusPoller.#intervalHandle = setInterval(
            MaintenanceStatusPoller.#poll,
            MaintenanceStatusPoller.#POLL_INTERVAL_MILLISECONDS
        );
        MaintenanceStatusPoller.#poll();
    }

    static stop()
    {
        if (MaintenanceStatusPoller.#intervalHandle === null)
        {
            return;
        }
        clearInterval(MaintenanceStatusPoller.#intervalHandle);
        MaintenanceStatusPoller.#intervalHandle = null;
    }

    static getLastStatus()
    {
        return MaintenanceStatusPoller.#lastStatus;
    }

    static async #poll()
    {
        try
        {
            const response = await fetch(MaintenanceStatusPoller.#STATUS_ENDPOINT, { credentials: "same-origin" });
            if (!response.ok)
            {
                return;
            }

            const payload = await response.json();
            const status = {
                active: payload?.active || null,
                upcoming: Array.isArray(payload?.upcoming) ? payload.upcoming : []
            };

            MaintenanceStatusPoller.#lastStatus = status;
            window.dispatchEvent(new CustomEvent(MaintenanceEvents.STATUS_UPDATED, { detail: status }));
        }
        catch (pollError)
        {
            // Network blip — try again next interval.
        }
    }
}

export default MaintenanceStatusPoller;
