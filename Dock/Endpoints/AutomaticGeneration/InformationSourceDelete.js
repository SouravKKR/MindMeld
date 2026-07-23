const { PacketronRequest, PacketronResponse } = require("@gamiumgamers/packetron");
const { getUser } = require("../Helpers/GetUser");
const InformationSourceQueryEngine = require("../../Globals/Classes/Database/InformationSourceQueryEngine");
const StorageQuotaEnforcer = require("../../Globals/Classes/Storage/StorageQuotaEnforcer");
const Persistence = require("../../Globals/Classes/Persistence");
const { storageTargets } = require("../../Globals/Enumerations/StorageTargets");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");
const path = require("path");

/**
 * Deletes one of the authenticated user's uploaded information sources.
 * Expects a JSON body: { informationSourceId: string }.
 *
 * Authorization is re-checked server-side against the stored row — the client
 * id is never trusted. Ownership is confirmed from the row's own userId, not
 * from the request payload.
 *
 * Content-addressed-store safety: upload blobs are shared across users (two
 * users who upload the same file get two rows with the same hash pointing at
 * one blob — see InformationSourceUpload's bAlreadyInContentStore reuse). So
 * the row is deleted FIRST, then the blob is removed ONLY when no other row
 * still references that hash (isLastInformationSourceWithSameContent, checked
 * after the delete so the row being removed isn't counted). Deleting the row
 * before the check also means a wrongful blob delete can never precede the row
 * removal; a stray orphaned blob (lost race) is harmless.
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

    await InformationSourceQueryEngine.deleteInformationSource(informationSource);

    // Only remove the shared blob when this was the last row referencing its
    // content. A storage-layer failure here must not fail the delete — the row
    // (the user-facing entity and the billed footprint) is already gone.
    try
    {
        const bIsLastReference = await InformationSourceQueryEngine.isLastInformationSourceWithSameContent(informationSource);
        if (bIsLastReference)
        {
            const blobPath = path.join(informationSource.getDirectoryPath(), informationSource.getHash());
            await Persistence.delete(blobPath, storageTargets.LINODE_OBJECT_STORAGE);
        }
    }
    catch (blobDeletionError)
    {
        console.warn(`[InformationSourceDelete] Row deleted but blob cleanup failed for ${informationSourceId}: ${blobDeletionError?.message || blobDeletionError}`);
    }

    // The footprint shrank — drop the cached measurement so the storage meter
    // and the next quota check re-measure, mirroring the upload path.
    StorageQuotaEnforcer.invalidate(user.getId());

    response.statusCode = httpStatus.OK;
    response.sendJson({ success: true });
}

module.exports = { handleInformationSourceDelete };
