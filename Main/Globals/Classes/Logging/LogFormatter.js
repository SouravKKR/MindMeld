import { logLevel } from "../../Enumerations/LogLevel.js";

const SEVERITY_NAME_BY_LEVEL = Object.fromEntries(Object.entries(logLevel).map(([name, value]) => [value, name]));

/**
 * LogFormatter (browser) — mirrors the plain single-line format produced by the
 * Dock and Agent formatters, so the admin console renders lines identical to what
 * the ".log" download contains. The colour-coded ".html" download is rendered
 * server-side; the console colours lines via severityClassName + theme CSS.
 */
class LogFormatter
{
    static severityName(level)
    {
        return SEVERITY_NAME_BY_LEVEL[level] || "INFO";
    }

    static severityClassName(level)
    {
        return `log-level-${LogFormatter.severityName(level).toLowerCase()}`;
    }

    static #resolveIsoString(document)
    {
        if (typeof document.timestampIsoString === "string" && document.timestampIsoString.length > 0)
        {
            return document.timestampIsoString;
        }
        if (document.timestamp)
        {
            const date = new Date(document.timestamp);
            if (!Number.isNaN(date.getTime()))
            {
                return date.toISOString();
            }
        }
        return "";
    }

    static formatLine(document)
    {
        const severity = LogFormatter.severityName(document.level);
        const isoString = LogFormatter.#resolveIsoString(document);
        const title = typeof document.title === "string" ? document.title : "";
        const message = typeof document.message === "string" ? document.message : "";

        let line = `${severity}:[${isoString}]:${title}: ${message}`;

        const extras = {};
        if (document.accountId)
        {
            extras.accountId = document.accountId;
        }
        if (document.errorCode)
        {
            extras.errorCode = document.errorCode;
        }
        if (document.errorReason)
        {
            extras.errorReason = document.errorReason;
        }
        if (document.additionalData && typeof document.additionalData === "object" && Object.keys(document.additionalData).length > 0)
        {
            extras.additionalData = document.additionalData;
        }
        if (Object.keys(extras).length > 0)
        {
            line += ` ${JSON.stringify(extras)}`;
        }
        return line;
    }
}

export default LogFormatter;
