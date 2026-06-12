const { PacketronPlugin, PacketronPluginPriority } = require("@gamiumgamers/packetron");
const { getSession } = require("../Helpers/GetSession");
const RateLimiter = require("../../Globals/Classes/Security/RateLimiter");
const RateLimitEventQueryEngine = require("../../Globals/Classes/Database/RateLimitEventQueryEngine");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");

/**
 * EnsureRateLimit
 *
 * A single global plugin that implements the two halves of the rate-limiting
 * requirement:
 *
 *   1. Per-user enforcement. Every non-static request is counted against the
 *      caller's identity (the session user id when authenticated, otherwise the
 *      client IP). Exceeding RateLimiter.DEFAULT_PER_USER_MAX_REQUESTS within the
 *      window yields a 429. This complements Packetron's built-in
 *      maxRequestsPerSecond per-route cap (the "overall" dimension), which is
 *      applied separately in index.js.
 *
 *   2. 429 logging. The plugin attaches a one-shot "finish" listener to the
 *      response BEFORE routing happens, so it observes every 429 the server
 *      emits — the built-in overall cap (raised inside the router, after global
 *      plugins), this plugin's own per-user 429, and any feature-specific
 *      cooldown/quota 429 raised inside a handler — and persists it via
 *      RateLimitEventQueryEngine so admins can review them in the admin panel.
 *
 * Why a global plugin: Packetron runs global plugins before the request router,
 * and the built-in per-route limiter raises its 429 inside the router before any
 * route-local plugin runs. Only a global plugin can attach a listener early
 * enough to capture those built-in 429s.
 *
 * Static resources are intentionally excluded (the requirement scopes limits to
 * "all endpoints excluding static resources"); a flooded page load pulling many
 * asset files must not trip a per-user cap.
 *
 * To stop a sustained flood from amplifying into one DB write per rejected
 * request, event logging is throttled to one row per (scope, identity, endpoint)
 * per minute via an in-memory limiter.
 */

const STATIC_RESOURCE_EXTENSIONS = new Set
([
    "js", "mjs", "css", "map", "json", "wasm", "txt", "html", "htm",
    "png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp",
    "woff", "woff2", "ttf", "otf", "eot",
    "mp3", "mp4", "webm", "wav", "ogg", "bin", "data", "pdf", "csv"
]);

const perUserLimiter = new RateLimiter(RateLimiter.DEFAULT_PER_USER_MAX_REQUESTS, RateLimiter.DEFAULT_PER_USER_WINDOW_MILLISECONDS);

// One logged event per (scope, identity, endpoint) per minute — keeps the event
// log (and the DB) from being flooded while still surfacing every distinct abuse.
const loggingThrottle = new RateLimiter(1, 60 * 1000);

function getEndpointPath(request)
{
    const rawUrl = typeof request.url === "string" ? request.url : "";
    return rawUrl.split("?")[0] || "/";
}

function isStaticResourcePath(endpointPath)
{
    const normalized = endpointPath.replace(/^\/+/, "").toLowerCase();

    // Root "/" and "/index.html" are the SPA shell — treat as static so page
    // loads/navigations are never per-user throttled.
    if (normalized === "")
    {
        return true;
    }

    if (normalized.startsWith("assets/"))
    {
        return true;
    }

    const lastSegment = normalized.substring(normalized.lastIndexOf("/") + 1);
    const dotIndex = lastSegment.lastIndexOf(".");
    if (dotIndex === -1)
    {
        return false;
    }

    const extension = lastSegment.substring(dotIndex + 1);
    return STATIC_RESOURCE_EXTENSIONS.has(extension);
}

async function resolveIdentity(request)
{
    let userId = null;

    try
    {
        const session = await getSession(request);
        userId = session ? session.getUserId() : null;
    }
    catch (sessionLookupError)
    {
        userId = null;
    }

    let ipAddress = "unknown";
    try
    {
        ipAddress = (await request.getIp()) || "unknown";
    }
    catch (ipLookupError)
    {
        ipAddress = (request.socket && request.socket.remoteAddress) || "unknown";
    }

    if (userId)
    {
        return { key: `user:${userId}`, type: "USER", userId: userId, ipAddress: ipAddress };
    }

    return { key: `ip:${ipAddress}`, type: "IP", userId: null, ipAddress: ipAddress };
}

function logRateLimitEvent(request, response)
{
    if (response.statusCode !== 429)
    {
        return;
    }

    const endpoint = getEndpointPath(request);
    const identity = request.__rateLimitIdentity ||
    {
        key: `ip:${(request.socket && request.socket.remoteAddress) || "unknown"}`,
        type: "IP",
        userId: null,
        ipAddress: (request.socket && request.socket.remoteAddress) || "unknown"
    };

    // Scope is stamped by this plugin's own enforcement; an unmarked 429 came
    // from the built-in per-endpoint overall cap or a handler-level cooldown.
    const info = request.__rateLimitInfo || { scope: "OVERALL", limit: null, windowMilliseconds: null, retryAfterSeconds: null };

    const dedupeKey = `${info.scope}:${identity.key}:${endpoint}`;
    if (!loggingThrottle.consume(dedupeKey).allowed)
    {
        return;
    }

    RateLimitEventQueryEngine.record
    ({
        endpoint: endpoint,
        method: request.method || "",
        scope: info.scope,
        identityType: identity.type,
        identityKey: identity.key,
        userId: identity.userId,
        ipAddress: identity.ipAddress,
        limit: info.limit,
        windowMilliseconds: info.windowMilliseconds,
        retryAfterSeconds: info.retryAfterSeconds
    }).catch(() => {});
}

const rateLimitPlugin = new PacketronPlugin
({
    priority: PacketronPluginPriority.EXTEMELY_HIGH,
    handler: async (request, response) =>
    {
        const endpoint = getEndpointPath(request);

        // Attach the 429 logger for EVERY request, before routing, so any 429 is
        // captured — the built-in overall cap (raised inside the router, even on
        // the SPA-shell routes), the per-user cap below, and handler-level
        // cooldowns. The check is cheap: one listener plus a statusCode test.
        if (!response.__rateLimitLoggerAttached)
        {
            response.__rateLimitLoggerAttached = true;
            response.on("finish", () =>
            {
                try
                {
                    logRateLimitEvent(request, response);
                }
                catch (loggingError)
                {
                    console.error("[EnsureRateLimit] Failed to log rate-limit event:", loggingError);
                }
            });
        }

        // Static resources (and the SPA shell) are excluded from per-user
        // ENFORCEMENT: a page load pulling many asset files must not trip a cap.
        // Their 429s, if any, are still logged by the listener attached above.
        if (isStaticResourcePath(endpoint))
        {
            return false;
        }

        const identity = await resolveIdentity(request);
        request.__rateLimitIdentity = identity;

        const decision = perUserLimiter.consume(identity.key);
        if (!decision.allowed)
        {
            request.__rateLimitInfo =
            {
                scope: "PER_USER",
                limit: decision.limit,
                windowMilliseconds: decision.windowMilliseconds,
                retryAfterSeconds: decision.retryAfterSeconds
            };

            response.statusCode = httpStatus.TOO_MANY_REQUESTS;
            response.setHeader("Retry-After", String(decision.retryAfterSeconds));
            response.sendJson({ error: "RATE_LIMITED", scope: "PER_USER", retryAfterSeconds: decision.retryAfterSeconds });
            return true;
        }

        return false;
    }
});

module.exports = { rateLimitPlugin };
