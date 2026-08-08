const { PacketronRequest, PacketronResponse } = require("@gamiumgamers/packetron");
const { getUser } = require("../Helpers/GetUser");
const InformationSourceQueryEngine = require("../../Globals/Classes/Database/InformationSourceQueryEngine");
const ReferencedProofSourceHashes = require("../../Globals/Classes/Content/ReferencedProofSourceHashes");
const InformationSourcePurger = require("../../Globals/Classes/Content/InformationSourcePurger");
const SourceRetentionPolicy = require("../../Globals/Classes/Content/SourceRetentionPolicy");
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

    // A source cited as a licensing basis cannot be deleted, by its owner or by
    // the reaper — whether it was the reference a content correction was made
    // from, or a document declared as a verification source for a paid deck. The
    // declaration recorded against it asserts the platform was entitled to use
    // the document, and that assertion is worth nothing once the document is
    // gone — so the delete is refused with an explanation rather than the record
    // being left pointing at bytes that no longer exist.
    const referencedProofHashes = await ReferencedProofSourceHashes.findForUser(user.getId());

    if (SourceRetentionPolicy.isSourceUnderLegalHold(informationSource, referencedProofHashes))
    {
        response.statusCode = httpStatus.CONFLICT;
        response.sendJson({
            error: ErrorCodes.SOURCE_UNDER_LEGAL_HOLD,
            detail: "This document is recorded as the licensing basis for a content correction or for the verification "
                + "of a paid deck, so it has to be kept as proof of that permission. It cannot be deleted while that "
                + "record stands."
        });
        return;
    }

    // The purger owns the whole cascade — row, then blob, then derived content
    // (embedding chunks, figure rows, and the figure images those rows point at
    // in object storage) — and invalidates the cached storage measurement.
    // Sharing it with the expiry reaper, account closure and the admin takedown
    // path keeps the four from drifting.
    const purgeResult = await InformationSourcePurger.purgeSingleSource(informationSource);

    response.statusCode = httpStatus.OK;
    response.sendJson({
        success: true,
        contentRemoved: purgeResult.bContentRemoved,
        embeddingChunksRemoved: purgeResult.embeddingChunksRemoved,
        figuresRemoved: purgeResult.figuresRemoved,
        figureObjectsRemoved: purgeResult.figureObjectsRemoved
    });
}

module.exports = { handleInformationSourceDelete };
