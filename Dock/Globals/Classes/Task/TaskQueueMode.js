const App = require("../App");

// Single source of truth for "is the distributed Redis task queue active?".
// Both TaskManager.execute() (deciding queue vs local subprocess) and index.js
// (deciding whether to start the local worker supervisor + burst autoscaler)
// consult this, so the policy lives in exactly one place.
//
// Queue mode is ON only in production (server started WITHOUT --debug) AND when
// DOCK_USE_TASK_QUEUE is explicitly truthy. In --debug the server always uses the
// original local-subprocess path, so local development is completely unchanged.

class TaskQueueMode
{
    /**
     * @returns {boolean}
     */
    static isQueueEnabled()
    {
        if (App.isDebug())
        {
            return false;
        }

        return TaskQueueMode.#resolveBooleanSetting("DOCK_USE_TASK_QUEUE", false);
    }

    /**
     * Reads a boolean from the environment. Accepts 1/true/yes/on (any case) as
     * true and anything else (including unset) as the fallback.
     *
     * @param {string} environmentVariableName
     * @param {boolean} fallbackValue
     * @returns {boolean}
     */
    static #resolveBooleanSetting(environmentVariableName, fallbackValue)
    {
        const rawValue = process.env[environmentVariableName];

        if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "")
        {
            return fallbackValue;
        }

        const normalized = String(rawValue).trim().toLowerCase();
        return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
    }
}

module.exports = TaskQueueMode;
