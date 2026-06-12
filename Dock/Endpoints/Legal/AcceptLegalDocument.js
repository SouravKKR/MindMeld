const { PacketronRequest, PacketronResponse } = require("@gamiumgamers/packetron");
const { getUser } = require("../Helpers/GetUser");
const LegalAcceptanceService = require("../../Globals/Classes/Authentication/LegalAcceptanceService");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");

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
        response.sendStatusCode(401);
        return;
    }

    const body = await request.getBody();
    const documentKey = typeof body?.documentKey === "string" ? body.documentKey : "";
    const claimedVersion = (body && body.version !== undefined && body.version !== null) ? Number(body.version) : null;

    if (!documentKey)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: "MISSING_DOCUMENT_KEY" });
        return;
    }

    const result = await LegalAcceptanceService.recordAcceptance(user.getId(), documentKey, claimedVersion);

    if (!result.ok)
    {
        if (result.reason === "VERSION_MISMATCH")
        {
            response.statusCode = httpStatus.CONFLICT;
            response.sendJson({ error: "VERSION_MISMATCH", documents: result.documents || [] });
            return;
        }

        if (result.reason === "UNKNOWN_DOCUMENT")
        {
            response.statusCode = httpStatus.NOT_FOUND;
            response.sendJson({ error: "UNKNOWN_DOCUMENT" });
            return;
        }

        if (result.reason === "INVALID_REQUEST")
        {
            response.statusCode = httpStatus.BAD_REQUEST;
            response.sendJson({ error: "INVALID_REQUEST" });
            return;
        }

        response.sendStatusCode(500);
        return;
    }

    response.sendJson({ additionalData: result.additionalData });
}

module.exports = { handleAcceptLegalDocument };
