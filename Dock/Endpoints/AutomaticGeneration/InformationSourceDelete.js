const { PacketronRequest, PacketronResponse } = require("@gamiumgamers/packetron");
const { getUser } = require("../Helpers/GetUser");
const InformationSourceQueryEngine = require("../../Globals/Classes/Database/InformationSourceQueryEngine");
const InformationSourcePurger = require("../../Globals/Classes/Content/InformationSourcePurger");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");

/**
 * Deletes one of the authenticated user's uploaded information sources.
 * Expects a JSON body: { informationSourceId: string }.
 *
 * Authorization is re-checked server-side against the stored row — the client
 * id is never trusted. Ownership is confirmed from the row's own userId, not
 * from the request payload.
 *
 * Content-addressed-store safety and the derived-content cascade both live in
 * InformationSourcePurger — see that class for the ordering discipline. In
 * short: upload blobs are shared across users, so the row is deleted first and
 * the blob plus everything derived from it (embedding chunks, cached figures)
 * is removed only once no other row references that hash.
 *
 * @param {PacketronRequest} request
 * @param {PacketronResponse} response
 */
async function handleInformationSourceDelete(request, response)
{
    const user = await getUser(request);

    if (!user)
    {
        response.statusCode = httpStatus.UNAUTHORIZED;
        response.end("Unauthorized.");
        return;
    }

    const body = await request.getBody();
    const informationSourceId = body ? body.informationSourceId : null;

    if (!informationSourceId)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.MISSING_INFORMATION_SOURCE_ID });
        return;
    }

    const informationSource = await InformationSourceQueryEngine.getInformationSourceById(informationSourceId);

    if (informationSource === null)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ error: ErrorCodes.INFORMATION_SOURCE_NOT_FOUND });
        return;
    }

    // Re-check ownership against the stored record — the request must not be
    // able to name another user's source by id.
    if (informationSource.getUserId() !== user.getId())
    {
        response.statusCode = httpStatus.FORBIDDEN;
        response.sendJson({ error: ErrorCodes.INFORMATION_SOURCE_NOT_OWNED });
        return;
    }

    // The purger owns the whole cascade — row, then blob and derived content
    // (embedding chunks + cached figures) when this was the last reference —
    // and invalidates the cached storage measurement. Sharing it with the
    // expiry reaper and the admin takedown path keeps the three from drifting.
    const purgeResult = await InformationSourcePurger.purgeSingleSource(informationSource);

    response.statusCode = httpStatus.OK;
    response.sendJson({
        success: true,
        contentRemoved: purgeResult.bContentRemoved,
        embeddingChunksRemoved: purgeResult.embeddingChunksRemoved,
        figuresRemoved: purgeResult.figuresRemoved
    });
}

module.exports = { handleInformationSourceDelete };
