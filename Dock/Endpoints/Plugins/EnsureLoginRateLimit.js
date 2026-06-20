const { PacketronPlugin } = require("@gamiumgamers/packetron");
const RateLimiter = require("../../Globals/Classes/Security/RateLimiter");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");

/**
 * EnsureLoginRateLimit
 *
 * A route-local plugin that applies a dedicated, tight per-IP cap to the OAuth
 * login handshake (/Login and /Login/Callback). The global EnsureRateLimit
 * plugin already caps every identity at the generous app-traffic level, but
 * that ceiling is far too high to deter login-specific abuse — rapid Google
 * token exchanges, account churn, and callback probing for email enumeration.
 * Authentication is unauthenticated by definition, so the only stable identity
 * here is the client IP.
 *
 * On rejection it emits a 429 with Retry-After and stamps request.__rateLimitInfo
 * with scope "LOGIN" so the global 429 logger (EnsureRateLimit's finish listener)
 * records it in the same admin-visible rate-limit event log as every other 429.
 */

const loginLimiter = new RateLimiter(RateLimiter.DEFAULT_LOGIN_MAX_REQUESTS, RateLimiter.DEFAULT_LOGIN_WINDOW_MILLISECONDS);

async function resolveClientIp(request)
{
    try
    {
        return (await request.getIp()) || "unknown";
    }
    catch (ipLookupError)
    {
        return (request.socket && request.socket.remoteAddress) || "unknown";
    }
}

const ensureLoginRateLimit = new PacketronPlugin
({
    handler: async (request, response) =>
    {
        const ipAddress = await resolveClientIp(request);
        const identityKey = `login-ip:${ipAddress}`;

        // Stamp the identity so the global 429 logger attributes the event even
        // though this is an unauthenticated request.
        request.__rateLimitIdentity =
        {
            key: identityKey,
            type: "IP",
            userId: null,
            ipAddress: ipAddress
        };

        const decision = loginLimiter.consume(identityKey);
        if (!decision.allowed)
        {
            request.__rateLimitInfo =
            {
                scope: "LOGIN",
                limit: decision.limit,
                windowMilliseconds: decision.windowMilliseconds,
                retryAfterSeconds: decision.retryAfterSeconds
            };

            response.statusCode = httpStatus.TOO_MANY_REQUESTS;
            response.setHeader("Retry-After", String(decision.retryAfterSeconds));
            response.sendJson({ error: ErrorCodes.RATE_LIMITED, scope: "LOGIN", retryAfterSeconds: decision.retryAfterSeconds });
            return true;
        }

        return false;
    }
});

module.exports = { ensureLoginRateLimit };
