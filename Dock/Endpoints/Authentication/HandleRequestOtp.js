const OtpManager = require("../../Globals/Classes/Authentication/OtpManager");
const AccessGate = require("../../Globals/Classes/Authentication/AccessGate");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function handleRequestOtp(request, response)
{
    const body = await request.getBody();
    const submittedEmail = typeof body?.email === "string" ? body.email.trim() : "";

    if (!submittedEmail || !EMAIL_REGEX.test(submittedEmail))
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: ErrorCodes.INVALID_EMAIL });
        return;
    }

    // Per-environment login allowlist. When enabled (dev / test only), refuse
    // to even send a code to a disallowed email. Disabled in production, so
    // this short-circuits to allowed and every email proceeds as before.
    if (!await AccessGate.isEmailAllowed(submittedEmail))
    {
        response.statusCode = httpStatus.FORBIDDEN;
        response.sendJson({ success: false, error: ErrorCodes.ACCESS_NOT_ALLOWED });
        return;
    }

    let result;
    try
    {
        result = await OtpManager.requestOtp(submittedEmail);
    }
    catch (otpError)
    {
        console.error(`[HandleRequestOtp] OTP request failed for ${submittedEmail}: ${otpError.message}`);
        response.statusCode = httpStatus.BAD_GATEWAY;
        response.sendJson({ success: false, error: ErrorCodes.EMAIL_DELIVERY_FAILED });
        return;
    }

    if (!result.ok)
    {
        if (result.reason === ErrorCodes.RATE_LIMITED)
        {
            response.statusCode = httpStatus.TOO_MANY_REQUESTS;
            response.sendJson({ success: false, error: ErrorCodes.RATE_LIMITED, retryAfterSeconds: result.retryAfterSeconds });
            return;
        }
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: result.reason || "UNKNOWN" });
        return;
    }

    response.sendJson
    ({
        success: true,
        isNewUser: result.isNewUser,
        retryAfterSeconds: result.retryAfterSeconds
    });
}

module.exports = { handleRequestOtp };
