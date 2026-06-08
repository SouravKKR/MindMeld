const OrgAdminVerificationManager = require("../../Globals/Classes/Authentication/OrgAdminVerificationManager");


async function verifyAdminVerificationOtp(request, response)
{
    const body = await request.getBody();
    const submittedEmail = typeof body?.email === "string" ? body.email.trim() : "";
    const submittedCode = typeof body?.code === "string" ? body.code.trim() : "";

    if (!submittedEmail || submittedEmail.indexOf("@") < 0)
    {
        response.statusCode = 400;
        response.sendJson({ success: false, error: "INVALID_EMAIL" });
        return;
    }
    if (!/^\d{6}$/.test(submittedCode))
    {
        response.statusCode = 400;
        response.sendJson({ success: false, error: "INVALID_CODE" });
        return;
    }

    const result = await OrgAdminVerificationManager.verifyAndIssueToken(submittedEmail, submittedCode);

    if (!result.ok)
    {
        response.statusCode = 400;
        const errorPayload = { success: false, error: result.reason || "UNKNOWN" };
        if (typeof result.attemptsRemaining === "number")
        {
            errorPayload.attemptsRemaining = result.attemptsRemaining;
        }
        response.sendJson(errorPayload);
        return;
    }

    response.statusCode = 200;
    response.sendJson({ success: true, verificationToken: result.verificationToken });
}

module.exports = { verifyAdminVerificationOtp };
