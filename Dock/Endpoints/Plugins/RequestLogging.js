const { PacketronPlugin, PacketronPluginPriority } = require("@gamiumgamers/packetron");
const Logger = require("../../Globals/Classes/Logger");
const LogTitles = require("../../Globals/Classes/Logging/LogTitles");
const { logCategory } = require("../../Globals/Enumerations/LogCategory");

/**
 * RequestLogging
 *
 * A single global plugin that records EVERY error the server returns — with its
 * error code and reason — into the central log. It mirrors the finish-listener
 * pattern used by EnsureRateLimit and AdminActionAuditor: attach once, before
 * routing, so it observes the final status of every request no matter which
 * handler produced it.
 *
 * It wraps response.sendJson to remember the JSON body the handler sent, so when
 * the response finishes it can pull the { error, reason } an endpoint returned and
 * record it (requirement: all error codes recorded with reason when they occur).
 * The acting account id is read from the identity the rate-limit plugin already
 * resolved, so this adds no extra database lookup on the hot path.
 *
 * Only responses with status >= 400 are logged (4xx as WARNING, 5xx as ERROR).
 * Normal completions are intentionally not logged here to keep log volume sane;
 * meaningful successful events are logged explicitly at their own call sites.
 */

function getEndpointPath(request)
{
    const rawUrl = typeof request.url === "string" ? request.url : "";
    return rawUrl.split("?")[0] || "/";
}

function shouldSkipPath(endpointPath)
{
    const normalized = endpointPath.replace(/^\/+/, "").toLowerCase();
    if (normalized === "")
    {
        return true;
    }
    if (normalized.startsWith("assets/") || normalized.startsWith("desktopupdates/"))
    {
        return true;
    }

    // Static asset files carry an extension; flat API routes never do — skip the
    // former so a page load's 404s do not flood the log.
    const lastSegment = normalized.substring(normalized.lastIndexOf("/") + 1);
    return lastSegment.includes(".");
}

function logRequestOutcome(request, response)
{
    const statusCode = Number(response.statusCode) || 0;
    if (statusCode < 400)
    {
        return;
    }

    const endpoint = getEndpointPath(request);
    if (shouldSkipPath(endpoint))
    {
        return;
    }

    const payload = response.__loggedResponsePayload;
    const errorCode = (payload && typeof payload === "object" && payload.error) ? String(payload.error) : "";
    const errorReason = (payload && typeof payload === "object" && payload.reason) ? String(payload.reason) : "";

    const identity = request.__rateLimitIdentity || null;
    const accountId = (identity && identity.userId) ? identity.userId : "";

    const options =
    {
        accountId: accountId,
        errorCode: errorCode,
        errorReason: errorReason,
        additionalData: { endpoint: endpoint, method: request.method || "", statusCode: statusCode }
    };

    const message = `${request.method || ""} ${endpoint} -> ${statusCode}${errorCode ? ` (${errorCode})` : ""}`;
    if (statusCode >= 500)
    {
        Logger.error(logCategory.ERROR, LogTitles.REQUEST_ERROR, message, options);
    }
    else
    {
        Logger.warning(logCategory.ERROR, LogTitles.REQUEST_ERROR, message, options);
    }
}

const requestLoggingPlugin = new PacketronPlugin
({
    priority: PacketronPluginPriority.EXTEMELY_HIGH,
    handler: async (request, response) =>
    {
        if (!response.__requestLoggingAttached)
        {
            response.__requestLoggingAttached = true;

            if (typeof response.sendJson === "function")
            {
                const originalSendJson = response.sendJson.bind(response);
                response.sendJson = (payload) =>
                {
                    response.__loggedResponsePayload = payload;
                    return originalSendJson(payload);
                };
            }

            response.on("finish", () =>
            {
                try
                {
                    logRequestOutcome(request, response);
                }
                catch (loggingError)
                {
                    console.error("[RequestLogging] Failed to log request outcome:", loggingError);
                }
            });
        }

        return false;
    }
});

module.exports = { requestLoggingPlugin };
