const OrgAdminVerificationManager = require("../../Globals/Classes/Authentication/OrgAdminVerificationManager");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");


async function sendAdminVerificationOtp(request, response)
{
    const body = await request.getBody();
    const submittedEmail = typeof body?.email === "string" ? body.email.trim() : "";
    const organizationName = typeof body?.organizationName === "string" ? body.organizationName.trim() : "";

    if (!submittedEmail || submittedEmail.indexOf("@") < 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: ErrorCodes.INVALID_EMAIL });
        return;
    }

    const result = await OrgAdminVerificationManager.requestVerification(submittedEmail, organizationName);

    if (!result.ok)
    {
        response.statusCode = result.reason === ErrorCodes.RATE_LIMITED ? httpStatus.TOO_MANY_REQUESTS : httpStatus.BAD_REQUEST;
        response.sendJson
        ({
            success: false,
            error: result.reason,
            retryAfterSeconds: result.retryAfterSeconds
        });
        return;
    }

    response.statusCode = httpStatus.OK;
    response.sendJson({ success: true, retryAfterSeconds: result.retryAfterSeconds });
}

module.exports = { sendAdminVerificationOtp };
