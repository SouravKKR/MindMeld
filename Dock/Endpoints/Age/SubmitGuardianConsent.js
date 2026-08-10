const { PacketronRequest, PacketronResponse } = require("@gamiumgamers/packetron");
const { getUser } = require("../Helpers/GetUser");
const AuthenticationQueryEngine = require("../../Globals/Classes/Database/AuthenticationQueryEngine");
const AgeVerificationService = require("../../Globals/Classes/Authentication/AgeVerificationService");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");

/**
 * POST /Age/GuardianConsent
 *
 * Body: { guardianName, guardianRelationship, guardianEmail, guardianContactNumber }
 *
 * Records a parent's or lawful guardian's consent for a Child's account, which
 * the Privacy Policy requires before the account's Personal Data may be
 * processed. Accepted only for an account the server has itself resolved as a
 * minor awaiting consent — the eligibility comes from the stored date of birth,
 * never from the request.
 *
 * What this records and what it does not. The stored entry is a consent RECORD:
 * who declared themselves the guardian, their relationship, and a contact
 * channel, with a server-stamped timestamp. It is not identity verification. The
 * Policy's "verifiable" standard needs an out-of-band confirmation step, and the
 * contact details captured here are what makes that step possible — treating
 * this write as the verification itself would overstate what happened.
 *
 * @param {PacketronRequest} request
 * @param {PacketronResponse} response
 */
async function handleSubmitGuardianConsent(request, response)
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

    // Re-read rather than trusting the session copy: eligibility is decided
    // from the stored date of birth, so it has to be the stored record that
    // decides it.
    const storedUser = await AuthenticationQueryEngine.getUserById(user.getId());

    if (!storedUser)
    {
        response.sendStatusCode(httpStatus.UNAUTHORIZED);
        return;
    }

    const result = await AgeVerificationService.recordGuardianConsent(user.getId(), storedUser,
    {
        guardianName: body?.guardianName,
        guardianRelationship: body?.guardianRelationship,
        guardianEmail: body?.guardianEmail,
        guardianContactNumber: body?.guardianContactNumber
    });

    if (!result.ok)
    {
        if (result.reason === ErrorCodes.AGE_DECLARATION_REQUIRED)
        {
            // The two steps are ordered. Answering 409 with the specific reason
            // lets the client reopen the date-of-birth prompt rather than
            // showing a dead end on the guardian form.
            response.statusCode = httpStatus.CONFLICT;
            response.sendJson({ error: ErrorCodes.AGE_DECLARATION_REQUIRED });
            return;
        }

        if (result.reason === ErrorCodes.GUARDIAN_CONSENT_NOT_APPLICABLE)
        {
            response.statusCode = httpStatus.CONFLICT;
            response.sendJson({ error: ErrorCodes.GUARDIAN_CONSENT_NOT_APPLICABLE });
            return;
        }

        if (result.reason === ErrorCodes.GUARDIAN_DETAILS_INCOMPLETE || result.reason === ErrorCodes.INVALID_REQUEST)
        {
            response.statusCode = httpStatus.BAD_REQUEST;
            response.sendJson({ error: result.reason });
            return;
        }

        response.sendStatusCode(httpStatus.INTERNAL_SERVER_ERROR);
        return;
    }

    response.sendJson({ state: result.state, additionalData: result.additionalData });
}

module.exports = { handleSubmitGuardianConsent };
