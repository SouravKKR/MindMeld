const { PacketronPlugin } = require("@gamiumgamers/packetron");
const RateLimiter = require("../../Globals/Classes/Security/RateLimiter");
const { getUser } = require("../Helpers/GetUser");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");

/**
 * EnsureEstimateCostRateLimit
 *
 * Route-local per-user cap on POST /Generate/EstimateCost.
 *
 * Estimating is cheap for the user and not free for us: every call loads the
 * credit configuration and walks the whole settings body. It is also on the
 * critical path now — Start Generation prices the run before it submits
 * anything — so the cap is sized to leave a normal decision (start, read,
 * cancel, adjust, start again) untouched while still stopping a script from
 * hammering it. The client re-uses its last answer for an unchanged form, so
 * the common case does not spend a request at all.
 *
 * Runs after ensureLogin, so getUser(request) is resolved by the time this does.
 * Stamps request.__rateLimitIdentity and request.__rateLimitInfo (scope
 * ESTIMATE_COST) so the global 429 logger records it like every other 429.
 *
 * The window is fixed rather than sliding, matching every other limiter here:
 * two calls either side of a boundary can land close together, which is fine for
 * deterring spam and keeps the counter allocation-light.
 */

const estimateCostLimiter = new RateLimiter(RateLimiter.DEFAULT_ESTIMATE_MAX_REQUESTS, RateLimiter.DEFAULT_ESTIMATE_WINDOW_MILLISECONDS);

const ensureEstimateCostRateLimit = new PacketronPlugin
({
    handler: async (request, response) =>
    {
        const user = await getUser(request);
        if (!user)
        {
            // Unauthenticated — ensureLogin (which runs first) already rejected it.
            return false;
        }

        const identityKey = `estimate-user:${user.getId()}`;
        request.__rateLimitIdentity =
        {
            key: identityKey,
            type: "USER",
            userId: user.getId(),
            ipAddress: null
        };

        const decision = estimateCostLimiter.consume(identityKey);
        if (!decision.allowed)
        {
            request.__rateLimitInfo =
            {
                scope: "ESTIMATE_COST",
                limit: decision.limit,
                windowMilliseconds: decision.windowMilliseconds,
                retryAfterSeconds: decision.retryAfterSeconds
            };

            response.statusCode = httpStatus.TOO_MANY_REQUESTS;
            response.setHeader("Retry-After", String(decision.retryAfterSeconds));
            response.sendJson({ error: ErrorCodes.RATE_LIMITED, scope: "ESTIMATE_COST", retryAfterSeconds: decision.retryAfterSeconds });
            return true;
        }

        return false;
    }
});

module.exports = { ensureEstimateCostRateLimit };
