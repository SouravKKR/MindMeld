const { PacketronRequest, PacketronResponse } = require("@gamiumgamers/packetron");
const { getUser } = require("../Helpers/GetUser");
const LegalAcceptanceService = require("../../Globals/Classes/Authentication/LegalAcceptanceService");
const StreakManager = require("../../Globals/Classes/Streak/StreakManager");
const AuthenticationQueryEngine = require("../../Globals/Classes/Database/AuthenticationQueryEngine");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");

/**
 * POST /Legal/Accept
 *
 * Body: { documentKey: string, version?: number }
 *
 * Records the authenticated user's acceptance of one legal document. This is
 * the ONLY path that may write consent state — the version stamped is the
 * server's current version (the optional `version` is used solely to reject a
 * stale acceptance), with a server-stamped timestamp. Replaces the previous
 * flow where the client merged an arbitrary `agreed<Key>Version` through the
 * generic /UpdateUserAdditionalData endpoint.
 *
 * Returns { additionalData } so the client can refresh its in-memory user
 * without a follow-up GetUser, mirroring the old endpoint's contract.
 *
 * @param {PacketronRequest} request
 * @param {PacketronResponse} response
 */
async function handleAcceptLegalDocument(request, response)
{
    const user = await getUser(request);

    if (!user)
    {
        response.sendStatusCode(httpStatus.UNAUTHORIZED);
        return;
    }

    const body = await request.getBody();
    const documentKey = typeof body?.documentKey === "string" ? body.documentKey : "";
    const claimedVersion = (body && body.version !== undefined && body.version !== null) ? Number(body.version) : null;

    if (!documentKey)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.MISSING_DOCUMENT_KEY });
        return;
    }

    const result = await LegalAcceptanceService.recordAcceptance(user.getId(), documentKey, claimedVersion);

    if (!result.ok)
    {
        if (result.reason === ErrorCodes.VERSION_MISMATCH)
        {
            response.statusCode = httpStatus.CONFLICT;
            response.sendJson({ error: ErrorCodes.VERSION_MISMATCH, documents: result.documents || [] });
            return;
        }

        if (result.reason === ErrorCodes.UNKNOWN_DOCUMENT)
        {
            response.statusCode = httpStatus.NOT_FOUND;
            response.sendJson({ error: ErrorCodes.UNKNOWN_DOCUMENT });
            return;
        }

        if (result.reason === ErrorCodes.INVALID_REQUEST)
        {
            response.statusCode = httpStatus.BAD_REQUEST;
            response.sendJson({ error: ErrorCodes.INVALID_REQUEST });
            return;
        }

        response.sendStatusCode(httpStatus.INTERNAL_SERVER_ERROR);
        return;
    }

    let additionalData = result.additionalData;

    // The streak is a reward for actively using the app, which legally requires
    // accepting the terms — so HandleGetUser withholds it while acceptance is
    // pending. This is where that debt is cleared: once the user has accepted
    // every current document, advance today's login streak so the comeback day
    // still counts (instead of waiting for the next bootstrap). Idempotent per
    // UTC day and fully guarded so a streak failure never fails the acceptance.
    try
    {
        const refreshedUser = await AuthenticationQueryEngine.getUserById(user.getId());
        if (refreshedUser && !(await LegalAcceptanceService.hasOutstandingAcceptance(refreshedUser)))
        {
            const streakResult = await StreakManager.recordDailyActivity(user.getId());
            if (streakResult.changed)
            {
                const withStreak = await AuthenticationQueryEngine.getUserById(user.getId());
                if (withStreak)
                {
                    additionalData = withStreak.getAdditionalData();
                }
            }
        }
    }
    catch (streakError)
    {
        console.warn(`[AcceptLegalDocument] Streak update failed for ${user.getId()}: ${streakError?.message || streakError}`);
    }

    response.sendJson({ additionalData });
}

module.exports = { handleAcceptLegalDocument };
