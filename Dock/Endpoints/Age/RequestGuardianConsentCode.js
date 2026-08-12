const { PacketronRequest, PacketronResponse } = require("@gamiumgamers/packetron");
const { getUser } = require("../Helpers/GetUser");
const AuthenticationQueryEngine = require("../../Globals/Classes/Database/AuthenticationQueryEngine");
const AgeVerificationService = require("../../Globals/Classes/Authentication/AgeVerificationService");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");

/**
 * POST /Age/GuardianConsent/RequestCode
 *
 * Body: { guardianName, guardianRelationship, guardianEmail, guardianContactNumber }
 *
 * STAGE ONE of guardian consent. Stores the declared guardian details as pending
 * and emails that address a six-digit code, together with the notice explaining
 * what CogniumLearn is, what is processed, and what supplying the code means.
 *
 * Nothing here unblocks the account. Submitting this endpoint any number of
 * times leaves the account exactly as blocked as it was — only
 * /Age/GuardianConsent/Verify writes the consent record that resolveState reads.
 * That split is what makes the flow worth having: before it, the details a child
 * typed WERE the consent.
 *
 * Eligibility comes from the stored declaration, never from the request, so the
 * account record is re-read before anything is decided.
 *
 * The response deliberately echoes the guardian address back. The child has to
 * be able to see they typed it correctly before waiting on a code that will
 * never arrive, and it is a value they just supplied rather than anything the
 * server is disclosing to them.
 *
 * @param {PacketronRequest} request
 * @param {PacketronResponse} response
 */
async function handleRequestGuardianConsentCode(request, response)
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

    const result = await AgeVerificationService.recordPendingGuardianDetails(user.getId(), storedUser,
    {
        guardianName: body?.guardianName,
        guardianRelationship: body?.guardianRelationship,
        guardianEmail: body?.guardianEmail,
        guardianContactNumber: body?.guardianContactNumber
    });

    if (!result.ok)
    {
        if (result.reason === ErrorCodes.AGE_DECLARATION_REQUIRED
            || result.reason === ErrorCodes.GUARDIAN_CONSENT_NOT_APPLICABLE)
        {
            // The steps are ordered. Answering 409 with the specific reason lets
            // the client reopen the step that is actually owed rather than
            // showing a dead end on the guardian form.
            response.statusCode = httpStatus.CONFLICT;
            response.sendJson({ error: result.reason });
            return;
        }

        if (result.reason === ErrorCodes.RATE_LIMITED)
        {
            response.statusCode = httpStatus.TOO_MANY_REQUESTS;
            response.setHeader("Retry-After", String(result.retryAfterSeconds || 60));
            response.sendJson({ error: ErrorCodes.RATE_LIMITED, retryAfterSeconds: result.retryAfterSeconds });
            return;
        }

        if (result.reason === ErrorCodes.GUARDIAN_DETAILS_INCOMPLETE
            || result.reason === ErrorCodes.GUARDIAN_EMAIL_SAME_AS_ACCOUNT
            || result.reason === ErrorCodes.INVALID_EMAIL
            || result.reason === ErrorCodes.INVALID_REQUEST)
        {
            response.statusCode = httpStatus.BAD_REQUEST;
            response.sendJson({ error: result.reason });
            return;
        }

        response.sendStatusCode(httpStatus.INTERNAL_SERVER_ERROR);
        return;
    }

    response.sendJson
    ({
        guardianEmail: result.guardianEmail,
        retryAfterSeconds: result.retryAfterSeconds
    });
}

module.exports = { handleRequestGuardianConsentCode };
