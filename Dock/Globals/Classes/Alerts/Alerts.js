const AlertQueryEngine = require("../Database/AlertQueryEngine");
const { alertSeverity } = require("../../Enumerations/AlertSeverity");
const Logger = require("../Logger");
const { logCategory } = require("../../Enumerations/LogCategory");

/**
 * Alerts
 *
 * Thin, non-throwing front door to the operational alert log. Recording an
 * alert must NEVER throw into — or slow a failure path of — the caller, so
 * every call is wrapped in try/catch and the DB write is fire-and-forget
 * unless the caller explicitly awaits. Other subsystems should depend on
 * this rather than AlertQueryEngine directly.
 *
 * Source labels are short, stable strings (e.g. "ECB_RATES",
 * "CURRENCY_CONVERTER") so dedupe groups them coherently in the admin tab.
 */
class Alerts
{
    static SEVERITY = alertSeverity;

    static async raise({ severity, source, title, message, metadata } = {})
    {
        // Bridge every operational alert into the central log so the admin Logs
        // view and downloads capture it alongside everything else. Never let the
        // mirror break alerting.
        try
        {
            Alerts.#mirrorToLog(severity, source, title, message, metadata);
        }
        catch (logMirrorError)
        {
            console.error("[Alerts] Failed to mirror alert to the log:", logMirrorError);
        }

        try
        {
            return await AlertQueryEngine.raise({ severity, source, title, message, metadata });
        }
        catch (alertError)
        {
            console.error("[Alerts] Failed to record alert:", alertError);
            return null;
        }
    }

    static #mirrorToLog(severity, source, title, message, metadata)
    {
        const options = { additionalData: (metadata && typeof metadata === "object") ? metadata : {} };
        const logTitle = title || source || "ALERT";
        const logMessage = message || "";

        if (severity === alertSeverity.ERROR)
        {
            Logger.error(logCategory.EVENT, logTitle, logMessage, options);
        }
        else if (severity === alertSeverity.WARNING)
        {
            Logger.warning(logCategory.EVENT, logTitle, logMessage, options);
        }
        else
        {
            Logger.info(logCategory.EVENT, logTitle, logMessage, options);
        }
    }

    static async info(source, title, message, metadata)
    {
        return Alerts.raise({ severity: alertSeverity.INFO, source, title, message, metadata });
    }

    static async warning(source, title, message, metadata)
    {
        return Alerts.raise({ severity: alertSeverity.WARNING, source, title, message, metadata });
    }

    static async error(source, title, message, metadata)
    {
        return Alerts.raise({ severity: alertSeverity.ERROR, source, title, message, metadata });
    }
}

module.exports = Alerts;
