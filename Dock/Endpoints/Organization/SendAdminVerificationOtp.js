const OrgAdminVerificationManager = require("../../Globals/Classes/Authentication/OrgAdminVerificationManager");


async function sendAdminVerificationOtp(request, response)
{
    const body = await request.getBody();
    const submittedEmail = typeof body?.email === "string" ? body.email.trim() : "";
    const organizationName = typeof body?.organizationName === "string" ? body.organizationName.trim() : "";

    if (!submittedEmail || submittedEmail.indexOf("@") < 0)
    {
        response.statusCode = 400;
        response.sendJson({ success: false, error: "INVALID_EMAIL" });
        return;
    }

    const result = await OrgAdminVerificationManager.requestVerification(submittedEmail, organizationName);

    if (!result.ok)
    {
        const httpStatus = result.reason === "RATE_LIMITED" ? 429 : 400;
        response.statusCode = httpStatus;
        response.sendJson
        ({
            success: false,
            error: result.reason,
            retryAfterSeconds: result.retryAfterSeconds
        });
        return;
    }

    response.statusCode = 200;
    response.sendJson({ success: true, retryAfterSeconds: result.retryAfterSeconds });
}

module.exports = { sendAdminVerificationOtp };
