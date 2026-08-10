const { authenticationProviders } = require("../../Globals/Enumerations/AuthenticationProviders");
const UserSession = require("../../Globals/Model/UserSession");
const AuthenticationQueryEngine = require("../../Globals/Classes/Database/AuthenticationQueryEngine");
const OtpManager = require("../../Globals/Classes/Authentication/OtpManager");
const AccessGate = require("../../Globals/Classes/Authentication/AccessGate");
const UserRoleReconciliator = require("../../Globals/Classes/Authentication/UserRoleReconciliator");
const OrganizationMemberQueryEngine = require("../../Globals/Classes/Organization/OrganizationMemberQueryEngine");
const OrganizationAutoAssigner = require("../../Globals/Classes/Organization/OrganizationAutoAssigner");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");
const {otpPurposes} = require("../../Globals/Enumerations/OtpPurposes");

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function handleVerifyOtp(request, response)
{
    const body = await request.getBody();
    const submittedEmail = typeof body?.email === "string" ? body.email.trim() : "";
    const submittedCode = typeof body?.code === "string" ? body.code.trim() : "";
    const submittedDisplayName = typeof body?.displayName === "string" ? body.displayName : "";

    if (!submittedEmail || !EMAIL_REGEX.test(submittedEmail))
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

    // Per-environment login allowlist. When enabled (dev / test only), refuse
    // to verify a disallowed email even if it somehow holds a valid code.
    // Disabled in production, so this short-circuits to allowed.
    if (!await AccessGate.isEmailAllowed(submittedEmail))
    {
        response.statusCode = httpStatus.FORBIDDEN;
        response.sendJson({ success: false, error: ErrorCodes.ACCESS_NOT_ALLOWED });
        return;
    }

    // LOGIN, explicitly. A code issued to confirm an intellectual-property
    // complaint reaches an address that may not belong to any account, and
    // accepting it here would turn "can you read this inbox" into a session.
    const result = await OtpManager.verifyOtp(submittedEmail, submittedCode, otpPurposes.LOGIN, submittedDisplayName);

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

    // Role reconciliation runs on every login path so a user whose
    // email is in the admin allowlist OR who has been appointed as an
    // org admin gets promoted on the next sign-in. The previous version
    // of this handler skipped the step entirely — that bug also masked
    // admin promotions for email-OTP-only super-admins.
    const userAfterVerify = await AuthenticationQueryEngine.getUserById(result.userId);
    if (userAfterVerify)
    {
        await UserRoleReconciliator.reconcile(userAfterVerify);
        await AuthenticationQueryEngine.createUser(userAfterVerify);
        const targetEmail = (userAfterVerify.getAdditionalData()?.email || "").toLowerCase();
        if (targetEmail.length > 0)
        {
            await OrganizationMemberQueryEngine.backfillUserId(targetEmail, userAfterVerify.getId());
        }
        try
        {
            await OrganizationAutoAssigner.applyFreePerksOnLogin(userAfterVerify);
        }
        catch (autoAssignError)
        {
            console.error(`[HandleVerifyOtp] applyFreePerksOnLogin failed for ${userAfterVerify.getId()}: ${autoAssignError.message}`);
        }
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
