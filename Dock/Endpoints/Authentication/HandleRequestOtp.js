const OtpManager = require("../../Globals/Classes/Authentication/OtpManager");

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function handleRequestOtp(request, response)
{
    const body = await request.getBody();
    const submittedEmail = typeof body?.email === "string" ? body.email.trim() : "";

    if (!submittedEmail || !EMAIL_REGEX.test(submittedEmail))
    {
        response.statusCode = 400;
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
        response.statusCode = 502;
        response.sendJson({ success: false, error: "EMAIL_DELIVERY_FAILED" });
        return;
    }

    if (!result.ok)
    {
        if (result.reason === "RATE_LIMITED")
        {
            response.statusCode = 429;
            response.sendJson({ success: false, error: "RATE_LIMITED", retryAfterSeconds: result.retryAfterSeconds });
            return;
        }
        response.statusCode = 400;
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
