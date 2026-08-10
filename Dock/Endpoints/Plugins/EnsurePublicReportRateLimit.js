const { PacketronPlugin } = require("@gamiumgamers/packetron");
const RateLimiter = require("../../Globals/Classes/Security/RateLimiter");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");

/**
 * EnsurePublicReportRateLimit
 *
 * A route-local per-IP cap for the endpoints that accept a report from someone
 * who is not signed in: the intellectual-property complaint form, its
 * confirmation step, its evidence upload, and the public account-access report.
 *
 * Mirrors EnsureOtpRateLimit exactly in shape — same identity resolution, same
 * `request.__rateLimitInfo` stamp so the global 429 logger records it in the
 * admin-visible register alongside every other limit — and differs only in
 * being sized more generously. See RateLimiter.DEFAULT_PUBLIC_REPORT_* for why.
 *
 * This is a VOLUMETRIC backstop and nothing more. It stops a script; it is not
 * the thing that decides whether a complaint is legitimate. That judgement is
 * PublicComplaintRateLimit's, and it flags rather than refuses, because a
 * refused complaint is a notice the platform did not receive.
 */

const publicReportLimiter = new RateLimiter(RateLimiter.DEFAULT_PUBLIC_REPORT_MAX_REQUESTS, RateLimiter.DEFAULT_PUBLIC_REPORT_WINDOW_MILLISECONDS);

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

const ensurePublicReportRateLimit = new PacketronPlugin
({
    handler: async (request, response) =>
    {
        const ipAddress = await resolveClientIp(request);
        const identityKey = `public-report-ip:${ipAddress}`;

        request.__rateLimitIdentity =
        {
            key: identityKey,
            type: "IP",
            userId: null,
            ipAddress: ipAddress
        };

        const decision = publicReportLimiter.consume(identityKey);

        if (!decision.allowed)
        {
            request.__rateLimitInfo =
            {
                scope: "PUBLIC_REPORT",
                limit: decision.limit,
                windowMilliseconds: decision.windowMilliseconds,
                retryAfterSeconds: decision.retryAfterSeconds
            };

            response.statusCode = httpStatus.TOO_MANY_REQUESTS;
            response.setHeader("Retry-After", String(decision.retryAfterSeconds));
            response.sendJson({ error: ErrorCodes.RATE_LIMITED, scope: "PUBLIC_REPORT", retryAfterSeconds: decision.retryAfterSeconds });
            return true;
        }

        return false;
    }
});

module.exports = { ensurePublicReportRateLimit };
