const { PacketronRequest, PacketronResponse } = require("@gamiumgamers/packetron");
const { getUser } = require("../Helpers/GetUser");
const AuthenticationQueryEngine = require("../../Globals/Classes/Database/AuthenticationQueryEngine");
const AgeVerificationService = require("../../Globals/Classes/Authentication/AgeVerificationService");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");

/**
 * POST /Age/GuardianConsent/Verify
 *
 * Body: { code: "123456" }
 *
 * STAGE TWO of guardian consent, and the only write in the flow that unblocks
 * an account. A matching code promotes the pending guardian details to the
 * confirmed consent record, stamped with the server's time and the method the
 * confirmation was obtained by.
 *
 * The body carries ONLY the code. The address the code is checked against comes
 * from the pending record the server stored in stage one — accepting an address
 * here would let a caller verify a code issued for one inbox and have the
 * consent filed against another.
 *
 * @param {PacketronRequest} request
 * @param {PacketronResponse} response
 */
async function handleVerifyGuardianConsentCode(request, response)
{
    const user = await getUser(request);

    if (!user)
    {
        response.sendStatusCode(httpStatus.UNAUTHORIZED);
        return;
    }

    let body;
    try
    {
        body = await request.getBody();
    }
    catch (bodyError)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_REQUEST });
        return;
    }

    const storedUser = await AuthenticationQueryEngine.getUserById(user.getId());

    if (!storedUser)
    {
        response.sendStatusCode(httpStatus.UNAUTHORIZED);
        return;
    }

    const submittedCode = typeof body?.code === "string" ? body.code.trim() : "";

    const result = await AgeVerificationService.confirmGuardianConsent(user.getId(), storedUser, submittedCode);

    if (!result.ok)
    {
        if (result.reason === ErrorCodes.AGE_DECLARATION_REQUIRED
            || result.reason === ErrorCodes.GUARDIAN_CONSENT_NOT_APPLICABLE
            || result.reason === ErrorCodes.GUARDIAN_CONSENT_CODE_NOT_REQUESTED)
        {
            response.statusCode = httpStatus.CONFLICT;
            response.sendJson({ error: result.reason });
            return;
        }

        if (result.reason === ErrorCodes.INVALID_CODE
            || result.reason === ErrorCodes.EXPIRED
            || result.reason === ErrorCodes.TOO_MANY_ATTEMPTS
            || result.reason === ErrorCodes.INVALID_EMAIL
            || result.reason === ErrorCodes.INVALID_REQUEST)
        {
            response.statusCode = httpStatus.BAD_REQUEST;
            // attemptsRemaining is echoed so the form can warn before the code is
            // burned, rather than failing five times and then silently needing a
            // fresh one.
            response.sendJson({ error: result.reason, attemptsRemaining: result.attemptsRemaining });
            return;
        }

        response.sendStatusCode(httpStatus.INTERNAL_SERVER_ERROR);
        return;
    }

    response.sendJson({ state: result.state, additionalData: result.additionalData });
}

module.exports = { handleVerifyGuardianConsentCode };
