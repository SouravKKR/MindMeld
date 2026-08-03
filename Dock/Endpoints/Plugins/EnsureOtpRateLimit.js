const { PacketronPlugin } = require("@gamiumgamers/packetron");
const RateLimiter = require("../../Globals/Classes/Security/RateLimiter");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");

/**
 * EnsureOtpRateLimit
 *
 * A route-local plugin that applies a dedicated, tight per-IP cap to the email-OTP
 * endpoints (/Auth/RequestOtp and /Auth/VerifyOtp). The global EnsureRateLimit
 * plugin already caps every identity at the generous app-traffic level, but that
 * ceiling is far too high for these unauthenticated endpoints: /Auth/RequestOtp
 * sends an email on every call, so the loose cap lets one IP trigger OTP emails to
 * unlimited distinct addresses (email-bomb / delivery-cost abuse) and spread code
 * guessing across re-issued codes. The per-email 60s resend cooldown and the
 * per-code 5-attempt cap in OtpManager only bound a single email/code — they do
 * not bound an attacker cycling many distinct emails from one source. OTP is
 * unauthenticated by definition, so the only stable identity here is the client IP.
 *
 * This mirrors EnsureLoginRateLimit. On rejection it emits a 429 with Retry-After
 * and stamps request.__rateLimitInfo with scope "OTP" so the global 429 logger
 * (EnsureRateLimit's finish listener) records it in the same admin-visible
 * rate-limit event log as every other 429.
 */

const otpLimiter = new RateLimiter(RateLimiter.DEFAULT_OTP_MAX_REQUESTS, RateLimiter.DEFAULT_OTP_WINDOW_MILLISECONDS);

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

const ensureOtpRateLimit = new PacketronPlugin
({
    handler: async (request, response) =>
    {
        const ipAddress = await resolveClientIp(request);
        const identityKey = `otp-ip:${ipAddress}`;

        // Stamp the identity so the global 429 logger attributes the event even
        // though this is an unauthenticated request.
        request.__rateLimitIdentity =
        {
            key: identityKey,
            type: "IP",
            userId: null,
            ipAddress: ipAddress
        };

        const decision = otpLimiter.consume(identityKey);
        if (!decision.allowed)
        {
            request.__rateLimitInfo =
            {
                scope: "OTP",
                limit: decision.limit,
                windowMilliseconds: decision.windowMilliseconds,
                retryAfterSeconds: decision.retryAfterSeconds
            };

            response.statusCode = httpStatus.TOO_MANY_REQUESTS;
            response.setHeader("Retry-After", String(decision.retryAfterSeconds));
            response.sendJson({ error: ErrorCodes.RATE_LIMITED, scope: "OTP", retryAfterSeconds: decision.retryAfterSeconds });
            return true;
        }

        return false;
    }
});

module.exports = { ensureOtpRateLimit };
