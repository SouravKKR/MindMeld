const { PacketronRequest, PacketronResponse } = require("@gamiumgamers/packetron");
const { getUser } = require("../Helpers/GetUser");
const AgeVerificationService = require("../../Globals/Classes/Authentication/AgeVerificationService");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");

/**
 * GET /Age/State
 *
 * Reports what the authenticated account still owes: nothing, a date of birth,
 * or guardian consent. The client calls this once at login so it can open the
 * right step directly, instead of discovering the requirement by having an
 * unrelated request rejected.
 *
 * Returns the derived state and never the stored date of birth itself. The
 * client only needs to know which prompt to show, and echoing a date of birth
 * back into a response body puts it in logs and caches for no purpose.
 *
 * @param {PacketronRequest} request
 * @param {PacketronResponse} response
 */
async function handleGetAgeConsentState(request, response)
{
    const user = await getUser(request);

    if (!user)
    {
        response.sendStatusCode(httpStatus.UNAUTHORIZED);
        return;
    }

    const consentState = AgeVerificationService.resolveState(user);

    response.sendJson
    ({
        state: consentState.state,
        processingAllowed: consentState.bProcessingAllowed
    });
}

module.exports = { handleGetAgeConsentState };
