const { logLevel } = require("../../Enumerations/LogLevel");

/**
 * LogFormatter — renders a stored log entry document into the single canonical
 * line format shared by the downloaded ".log" file and the live admin console:
 *
 *     <SEVERITY>:[<timestampIsoString>]:<Title>: <message>[ <compact JSON extras>]
 *
 * and into a self-contained, colour-coded HTML document for the ".html" download.
 * Keeping every representation in one class guarantees "what you see equals what
 * you download" and one place to change the severity-to-colour mapping.
 */
class LogFormatter
{
    static #severityNameByLevel = LogFormatter.#buildSeverityNameMap();

    // Hex colours are embedded directly in the HTML download so the file renders
    // correctly offline, with no dependency on the app's CSS theme variables.
    static #severityColorByLevel =
    {
        [logLevel.DEBUG]: "#8A8A99",
        [logLevel.INFO]: "#2EB6E0",
        [logLevel.WARNING]: "#F5B838",
        [logLevel.ERROR]: "#DC5050"
    };

    static #buildSeverityNameMap()
    {
        const nameByLevel = {};
        for (const [name, value] of Object.entries(logLevel))
        {
            nameByLevel[value] = name;
        }
        return nameByLevel;
    }

    static severityName(level)
    {
        return LogFormatter.#severityNameByLevel[level] ?? "INFO";
    }

    static severityColor(level)
    {
        return LogFormatter.#severityColorByLevel[level] ?? LogFormatter.#severityColorByLevel[logLevel.INFO];
    }

    static #resolveIsoString(logEntryDocument)
    {
        if (typeof logEntryDocument.timestampIsoString === "string" && logEntryDocument.timestampIsoString.length > 0)
        {
            return logEntryDocument.timestampIsoString;
        }

        const timestamp = logEntryDocument.timestamp instanceof Date ? logEntryDocument.timestamp : new Date(logEntryDocument.timestamp);
        return Number.isNaN(timestamp.getTime()) ? "" : timestamp.toISOString();
    }

    static #buildExtras(logEntryDocument)
    {
        const extras = {};
        if (logEntryDocument.accountId)
        {
            extras.accountId = logEntryDocument.accountId;
        }
        if (logEntryDocument.errorCode)
        {
            extras.errorCode = logEntryDocument.errorCode;
        }
        if (logEntryDocument.errorReason)
        {
            extras.errorReason = logEntryDocument.errorReason;
        }
        if (logEntryDocument.additionalData && typeof logEntryDocument.additionalData === "object" && Object.keys(logEntryDocument.additionalData).length > 0)
        {
            extras.additionalData = logEntryDocument.additionalData;
        }
        return extras;
    }

    /**
     * The canonical single-line representation (no colour). Used verbatim for the
     * ".log" download and as the text content of each coloured HTML line.
     */
    static formatLine(logEntryDocument)
    {
        const severity = LogFormatter.severityName(logEntryDocument.level);
        const isoString = LogFormatter.#resolveIsoString(logEntryDocument);
        const title = typeof logEntryDocument.title === "string" ? logEntryDocument.title : "";
        const message = typeof logEntryDocument.message === "string" ? logEntryDocument.message : "";

        let line = `${severity}:[${isoString}]:${title}: ${message}`;

        const extras = LogFormatter.#buildExtras(logEntryDocument);
        if (Object.keys(extras).length > 0)
        {
            line += ` ${JSON.stringify(extras)}`;
        }
        return line;
    }

    static #escapeHtml(text)
    {
        return String(text)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    /**
     * One colour-coded HTML line. The severity class drives the colour from the
     * embedded stylesheet in renderHtmlDocument; every value is escaped so log
     * content can never break the document or inject markup.
     */
    static renderHtmlLine(logEntryDocument)
    {
        const severity = LogFormatter.severityName(logEntryDocument.level);
        const escaped = LogFormatter.#escapeHtml(LogFormatter.formatLine(logEntryDocument));
        return `<div class="log-line log-level-${severity.toLowerCase()}">${escaped}</div>`;
    }

    /**
     * A self-contained, offline-portable HTML document colour-coded by severity.
     * Used by the ".html" download format.
     */
    static renderHtmlDocument(logEntryDocuments)
    {
        const lines = logEntryDocuments.map(logEntryDocument => LogFormatter.renderHtmlLine(logEntryDocument)).join("\n");
        const style = `
            body { background: #14141B; color: #D8D8E0; font-family: "Consolas", "Menlo", monospace; font-size: 13px; line-height: 1.5; margin: 0; padding: 16px; }
            .log-line { white-space: pre-wrap; word-break: break-word; }
            .log-level-debug { color: ${LogFormatter.severityColor(logLevel.DEBUG)}; }
            .log-level-info { color: ${LogFormatter.severityColor(logLevel.INFO)}; }
            .log-level-warning { color: ${LogFormatter.severityColor(logLevel.WARNING)}; }
            .log-level-error { color: ${LogFormatter.severityColor(logLevel.ERROR)}; font-weight: 600; }
        `;
        return `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>MindMeld Logs</title>\n<style>${style}</style>\n</head>\n<body>\n${lines}\n</body>\n</html>\n`;
    }
}

module.exports = LogFormatter;
