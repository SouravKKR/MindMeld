const OrgAdminVerificationManager = require("../../Globals/Classes/Authentication/OrgAdminVerificationManager");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");


async function verifyAdminVerificationOtp(request, response)
{
    const body = await request.getBody();
    const submittedEmail = typeof body?.email === "string" ? body.email.trim() : "";
    const submittedCode = typeof body?.code === "string" ? body.code.trim() : "";

    if (!submittedEmail || submittedEmail.indexOf("@") < 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: ErrorCodes.INVALID_EMAIL });
        return;
    }
    if (!/^\d{6}$/.test(submittedCode))
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: ErrorCodes.INVALID_CODE });
        return;
    }

    const result = await OrgAdminVerificationManager.verifyAndIssueToken(submittedEmail, submittedCode);

    if (!result.ok)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        const errorPayload = { success: false, error: result.reason || "UNKNOWN" };
        if (typeof result.attemptsRemaining === "number")
        {
            errorPayload.attemptsRemaining = result.attemptsRemaining;
        }
        response.sendJson(errorPayload);
        return;
    }

    response.statusCode = httpStatus.OK;
    response.sendJson({ success: true, verificationToken: result.verificationToken });
}

module.exports = { verifyAdminVerificationOtp };
