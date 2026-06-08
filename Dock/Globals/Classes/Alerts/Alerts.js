const AlertQueryEngine = require("../Database/AlertQueryEngine");
const { alertSeverity } = require("../../Enumerations/AlertSeverity");

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
