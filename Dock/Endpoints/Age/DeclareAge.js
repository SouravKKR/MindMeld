const { PacketronRequest, PacketronResponse } = require("@gamiumgamers/packetron");
const { getUser } = require("../Helpers/GetUser");
const AuthenticationQueryEngine = require("../../Globals/Classes/Database/AuthenticationQueryEngine");
const AgeVerificationService = require("../../Globals/Classes/Authentication/AgeVerificationService");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");

/**
 * POST /Age/DeclareAge
 *
 * Body: { ageYears: number }
 *
 * Records the authenticated user's age, once. This is the ONLY path that may
 * write it — the generic /UpdateUserAdditionalData merge refuses the field — and
 * whether the account holder is a Child is decided server-side from the stored
 * declaration rather than from a claim in the request.
 *
 * Replaces the earlier /Age/DeclareDateOfBirth. Only the side of eighteen the
 * account holder falls on is needed, and an age answers that while pinning the
 * person to a one-year window rather than to a single day. Accounts that already
 * declared a date of birth keep it and are not asked again; AgeVerificationService
 * still reads those.
 *
 * The account record is re-read from the database before the write rather than
 * trusting the session's copy, because write-once is only write-once if the
 * check runs against what is actually stored.
 *
 * Returns the resolved state so the client knows whether it is finished (an
 * adult) or must now collect guardian details (a minor), without a second
 * round trip.
 *
 * @param {PacketronRequest} request
 * @param {PacketronResponse} response
 */
async function handleDeclareAge(request, response)
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

    const result = await AgeVerificationService.recordDeclaredAge(user.getId(), storedUser, body?.ageYears);

    if (!result.ok)
    {
        if (result.reason === ErrorCodes.AGE_ALREADY_DECLARED)
        {
            // 409 rather than 400: the request was well formed, the account
            // state is what refuses it. A correction is an operator action by
            // design, so the client must not present this as a retryable
            // validation error.
            response.statusCode = httpStatus.CONFLICT;
            response.sendJson({ error: ErrorCodes.AGE_ALREADY_DECLARED });
            return;
        }

        if (result.reason === ErrorCodes.INVALID_AGE || result.reason === ErrorCodes.INVALID_REQUEST)
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
        state: result.state,
        ageYears: result.ageYears,
        additionalData: result.additionalData
    });
}

module.exports = { handleDeclareAge };
