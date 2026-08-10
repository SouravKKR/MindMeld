const { PacketronRequest, PacketronResponse } = require("@gamiumgamers/packetron");
const { getUser } = require("../Helpers/GetUser");
const AuthenticationQueryEngine = require("../../Globals/Classes/Database/AuthenticationQueryEngine");
const AgeVerificationService = require("../../Globals/Classes/Authentication/AgeVerificationService");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");

/**
 * POST /Age/DeclareDateOfBirth
 *
 * Body: { dateOfBirth: "YYYY-MM-DD" }
 *
 * Records the authenticated user's date of birth, once. This is the ONLY path
 * that may write it — the generic /UpdateUserAdditionalData merge refuses the
 * field — and the resulting age is derived server-side rather than accepting a
 * client's claim about whether it belongs to an adult.
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
async function handleDeclareDateOfBirth(request, response)
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

    const submittedDateOfBirth = typeof body?.dateOfBirth === "string" ? body.dateOfBirth : "";

    const storedUser = await AuthenticationQueryEngine.getUserById(user.getId());

    if (!storedUser)
    {
        response.sendStatusCode(httpStatus.UNAUTHORIZED);
        return;
    }

    const result = await AgeVerificationService.recordDateOfBirth(user.getId(), storedUser, submittedDateOfBirth);

    if (!result.ok)
    {
        if (result.reason === ErrorCodes.DATE_OF_BIRTH_ALREADY_DECLARED)
        {
            // 409 rather than 400: the request was well formed, the account
            // state is what refuses it. A correction is an operator action by
            // design, so the client must not present this as a retryable
            // validation error.
            response.statusCode = httpStatus.CONFLICT;
            response.sendJson({ error: ErrorCodes.DATE_OF_BIRTH_ALREADY_DECLARED });
            return;
        }

        if (result.reason === ErrorCodes.INVALID_DATE_OF_BIRTH || result.reason === ErrorCodes.INVALID_REQUEST)
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
        // The computed age, not the stored date. The client needs to branch on
        // adult-versus-minor and has no business re-deriving the boundary.
        ageYears: result.ageYears,
        additionalData: result.additionalData
    });
}

module.exports = { handleDeclareDateOfBirth };
