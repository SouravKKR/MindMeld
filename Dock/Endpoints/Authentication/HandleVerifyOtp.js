const { authenticationProviders } = require("../../Globals/Enumerations/AuthenticationProviders");
const UserSession = require("../../Globals/Model/UserSession");
const AuthenticationQueryEngine = require("../../Globals/Classes/Database/AuthenticationQueryEngine");
const OtpManager = require("../../Globals/Classes/Authentication/OtpManager");

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function handleVerifyOtp(request, response)
{
    const body = await request.getBody();
    const submittedEmail = typeof body?.email === "string" ? body.email.trim() : "";
    const submittedCode = typeof body?.code === "string" ? body.code.trim() : "";
    const submittedDisplayName = typeof body?.displayName === "string" ? body.displayName : "";

    if (!submittedEmail || !EMAIL_REGEX.test(submittedEmail))
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

    const result = await OtpManager.verifyOtp(submittedEmail, submittedCode, submittedDisplayName);

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

    const session = await AuthenticationQueryEngine.createSession(result.userId, authenticationProviders.EMAIL_OTP);

    const sessionLifetimeSeconds = Math.floor(UserSession.getExpirationTime() / 1000);
    response.setCookie("sessionId", session.getId(),
    {
        maxAge: sessionLifetimeSeconds,
        path: "/",
        httpOnly: true,
        secure: true,
        sameSite: "lax"
    });

    response.sendJson({ success: true });
}

module.exports = { handleVerifyOtp };
