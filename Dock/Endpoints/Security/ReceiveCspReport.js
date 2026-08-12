const Alerts = require("../../Globals/Classes/Alerts/Alerts");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");

/**
 * Receives Content-Security-Policy violation reports from browsers and records
 * them in the operational alert log, where they surface in the admin panel's
 * Alerts tab.
 *
 * This exists to make the strict-policy rollout observable: while the strict
 * policy rides along report-only (see SecurityHeaders), every resource it WOULD
 * have blocked arrives here. Once these stop appearing for real user sessions —
 * including the checkout and in-browser-LLM paths — the strict policy
 * can be promoted to enforcing with CONTENT_SECURITY_POLICY_MODE=strict.
 *
 * Deliberately unauthenticated: a browser posts a violation report without any
 * app context, and violations on the pre-login shell matter just as much as
 * post-login ones. That makes it a public write endpoint, so it is defensive
 * about what it accepts:
 *
 *   • Registered with PLAIN_TEXT_BODY — browsers send `application/csp-report`
 *     or `application/reports+json`, not `application/json`, so the body is
 *     parsed here rather than by the framework.
 *   • The body is size-capped before parsing.
 *   • Only a fixed set of short, truncated fields is ever persisted; nothing
 *     from the report is echoed back.
 *   • Alerts dedupes on (source, title), so a violation firing on every page
 *     load increments one counter instead of growing the collection. The global
 *     per-identity rate limiter caps the request volume itself.
 *
 * The response is always 204 with no body — a browser ignores it either way,
 * and a report that cannot be parsed is not worth an error surface.
 */

const MAXIMUM_REPORT_BODY_LENGTH = 16 * 1024;
const MAXIMUM_FIELD_LENGTH = 256;
const ALERT_SOURCE = "CSP_VIOLATION";

/**
 * Trims a reported field to a short, safe, single-line string.
 *
 * @param {*} rawValue the value taken from the violation report
 *
 * @returns {string} the normalized value, or an empty string
 */
function normalizeReportField(rawValue)
{
    if (typeof rawValue !== "string")
    {
        return "";
    }

    const collapsed = rawValue.replace(/\s+/g, " ").trim();
    return collapsed.length > MAXIMUM_FIELD_LENGTH ? collapsed.slice(0, MAXIMUM_FIELD_LENGTH) : collapsed;
}

/**
 * Normalizes a reported line or column number.
 *
 * @param {*} rawValue the value taken from the violation report
 *
 * @returns {number|null} the number, or null when absent or unusable
 */
function normalizeLineOrColumn(rawValue)
{
    const parsedValue = Number(rawValue);

    if (!Number.isInteger(parsedValue) || parsedValue < 0)
    {
        return null;
    }

    return parsedValue;
}

/**
 * Renders the "which file, where" part of the alert message.
 *
 * @param {string} sourceFile the reported source file
 * @param {number|null} lineNumber the reported line
 * @param {number|null} columnNumber the reported column
 *
 * @returns {string} a human-readable location, or an empty string
 */
function buildSourceLocation(sourceFile, lineNumber, columnNumber)
{
    if (sourceFile.length === 0)
    {
        return "";
    }

    if (lineNumber === null)
    {
        return sourceFile;
    }

    if (columnNumber === null)
    {
        return `${sourceFile}:${lineNumber}`;
    }

    return `${sourceFile}:${lineNumber}:${columnNumber}`;
}

/**
 * Reduces a blocked URI to just its scheme and host so the alert title stays
 * stable across the query strings and cache-busting paths that would otherwise
 * defeat deduplication. Non-URL values ("inline", "eval", "data") pass through.
 *
 * @param {string} blockedUri the report's blocked-uri field
 *
 * @returns {string} the grouping key for the blocked resource
 */
function summarizeBlockedUri(blockedUri)
{
    if (blockedUri.length === 0)
    {
        return "unknown";
    }

    try
    {
        return new URL(blockedUri).origin;
    }
    catch (parseError)
    {
        return blockedUri;
    }
}

/**
 * Extracts the violation payload from either report shape a browser may send:
 * the legacy `{ "csp-report": {...} }` envelope, or the Reporting API's
 * `[{ "type": "csp-violation", "body": {...} }]` array.
 *
 * @param {*} parsedBody the parsed report body
 *
 * @returns {object|null} the violation fields, or null when unrecognised
 */
function extractViolation(parsedBody)
{
    if (!parsedBody || typeof parsedBody !== "object")
    {
        return null;
    }

    if (Array.isArray(parsedBody))
    {
        const cspEntry = parsedBody.find(entry => entry && typeof entry === "object" && entry.body && typeof entry.body === "object");
        return cspEntry ? cspEntry.body : null;
    }

    const legacyReport = parsedBody["csp-report"];
    if (legacyReport && typeof legacyReport === "object")
    {
        return legacyReport;
    }

    return null;
}

async function receiveCspReport(request, response)
{
    // Answer first and record afterwards: the browser needs nothing from us,
    // and a slow alert write must never hold a user's page-load connection.
    response.sendStatusCode(httpStatus.NO_CONTENT);

    try
    {
        const rawBody = await request.getBody();

        if (typeof rawBody !== "string" || rawBody.length === 0 || rawBody.length > MAXIMUM_REPORT_BODY_LENGTH)
        {
            return;
        }

        const violation = extractViolation(JSON.parse(rawBody));
        if (violation === null)
        {
            return;
        }

        // "effective-directive" is the legacy spelling, "effectiveDirective" the
        // Reporting API one; fall back to the whole policy's violated directive.
        const violatedDirective = normalizeReportField
        (
            violation["effective-directive"] || violation.effectiveDirective || violation["violated-directive"] || violation.violatedDirective
        );
        const blockedUri = normalizeReportField(violation["blocked-uri"] || violation.blockedURL);
        const documentUri = normalizeReportField(violation["document-uri"] || violation.documentURL);
        const disposition = normalizeReportField(violation.disposition) || "report";

        // The script that actually tripped the policy, and where in it. Without
        // these a report like "script-src would block eval" says only THAT
        // something called eval, never WHICH file — which is the one thing
        // needed to act on it. Both report shapes are spelled differently.
        const sourceFile = normalizeReportField(violation["source-file"] || violation.sourceFile);
        const lineNumber = normalizeLineOrColumn(violation["line-number"] ?? violation.lineNumber);
        const columnNumber = normalizeLineOrColumn(violation["column-number"] ?? violation.columnNumber);
        const sampleText = normalizeReportField(violation["script-sample"] || violation.sample);

        const directiveLabel = violatedDirective.length > 0 ? violatedDirective : "unknown-directive";
        const sourceLocation = buildSourceLocation(sourceFile, lineNumber, columnNumber);

        const messageParts = [`A Content-Security-Policy violation was reported (disposition: ${disposition}).`];
        if (sourceLocation.length > 0)
        {
            messageParts.push(`Triggered by ${sourceLocation}.`);
        }
        if (sampleText.length > 0)
        {
            messageParts.push(`Sample: ${sampleText}`);
        }

        await Alerts.warning
        (
            ALERT_SOURCE,
            `${directiveLabel} would block ${summarizeBlockedUri(blockedUri)}`,
            messageParts.join(" "),
            {
                violatedDirective: directiveLabel,
                blockedUri: blockedUri,
                documentUri: documentUri,
                disposition: disposition,
                sourceFile: sourceFile,
                lineNumber: lineNumber,
                columnNumber: columnNumber,
                scriptSample: sampleText
            }
        );
    }
    catch (reportError)
    {
        // A malformed or truncated report is not an operational problem worth
        // an alert of its own — drop it.
        console.warn("[ReceiveCspReport] Discarded an unreadable CSP report:", reportError.message);
    }
}

module.exports = { receiveCspReport };
