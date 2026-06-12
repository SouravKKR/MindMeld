const OtpManager = require("../../Globals/Classes/Authentication/OtpManager");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function handleRequestOtp(request, response)
{
    const body = await request.getBody();
    const submittedEmail = typeof body?.email === "string" ? body.email.trim() : "";

    if (!submittedEmail || !EMAIL_REGEX.test(submittedEmail))
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: "INVALID_EMAIL" });
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
        response.sendJson({ success: false, error: "EMAIL_DELIVERY_FAILED" });
        return;
    }

    if (!result.ok)
    {
        if (result.reason === "RATE_LIMITED")
        {
            response.statusCode = httpStatus.TOO_MANY_REQUESTS;
            response.sendJson({ success: false, error: "RATE_LIMITED", retryAfterSeconds: result.retryAfterSeconds });
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
