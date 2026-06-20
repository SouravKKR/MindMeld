const { PacketronPlugin } = require("@gamiumgamers/packetron");
const RateLimiter = require("../../Globals/Classes/Security/RateLimiter");
const { getUser } = require("../Helpers/GetUser");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");

/**
 * EnsureMetricsRateLimit
 *
 * Route-local per-user cap on POST /Metrics/Sync. The metric counters are
 * client-reported, so beyond the server-side elapsed-time clamp this stops a
 * client from flooding the endpoint. The client flushes far less often than
 * this ceiling, so a legitimate user never trips it. Runs after ensureLogin, so
 * request.user is resolved by the time this runs. Stamps request.__rateLimitInfo
 * (scope METRICS) so the global 429 logger records it like every other 429.
 */

const METRICS_MAX_REQUESTS_PER_WINDOW = 30;
const METRICS_WINDOW_MILLISECONDS = 60 * 1000;

const metricsLimiter = new RateLimiter(METRICS_MAX_REQUESTS_PER_WINDOW, METRICS_WINDOW_MILLISECONDS);

const ensureMetricsRateLimit = new PacketronPlugin
({
    handler: async (request, response) =>
    {
        const user = await getUser(request);
        if (!user)
        {
            // Unauthenticated — ensureLogin (which runs first) already rejected it.
            return false;
        }

        const identityKey = `metrics-user:${user.getId()}`;
        request.__rateLimitIdentity =
        {
            key: identityKey,
            type: "USER",
            userId: user.getId(),
            ipAddress: null
        };

        const decision = metricsLimiter.consume(identityKey);
        if (!decision.allowed)
        {
            request.__rateLimitInfo =
            {
                scope: "METRICS",
                limit: decision.limit,
                windowMilliseconds: decision.windowMilliseconds,
                retryAfterSeconds: decision.retryAfterSeconds
            };

            response.statusCode = httpStatus.TOO_MANY_REQUESTS;
            response.setHeader("Retry-After", String(decision.retryAfterSeconds));
            response.sendJson({ error: ErrorCodes.RATE_LIMITED, scope: "METRICS", retryAfterSeconds: decision.retryAfterSeconds });
            return true;
        }

        return false;
    }
});

module.exports = { ensureMetricsRateLimit };
