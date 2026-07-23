const { PacketronRequest, PacketronResponse } = require("@gamiumgamers/packetron");
const { getUser } = require("../Helpers/GetUser");
const InformationSourceQueryEngine = require("../../Globals/Classes/Database/InformationSourceQueryEngine");
const Persistence = require("../../Globals/Classes/Persistence");
const { storageTargets } = require("../../Globals/Enumerations/StorageTargets");
const path = require("path");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");

/**
 * Downloads the file for an information source by fetching it from persistence.
 * Expects the information source id as an "informationsourceid" query parameter.
 * Returns 404 if the information source does not exist.
 * Returns 403 if no record exists with the same hash belonging to the authenticated user.
 *
 * @param {PacketronRequest} request - The request object.
 * @param {PacketronResponse} response - The response object.
 * @returns {Promise} A promise that resolves when the file has been sent.
 */
async function handleInformationSourceDownload(request, response)
{
    const user = await getUser(request);

    const queryParams = await request.getQueryParams();
    const informationSourceId = queryParams.informationsourceid;

    const informationSource = await InformationSourceQueryEngine.getInformationSourceById(informationSourceId);

    if (informationSource === null)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.end("Information source not found.");
        return;
    }

    const userOwnsSource = await InformationSourceQueryEngine.doesUserOwnInformationSourceWithHash(user.getId(), informationSource.getHash());

    if (!userOwnsSource)
    {
        response.statusCode = httpStatus.FORBIDDEN;
        response.end("You do not have permission to access this information source.");
        return;
    }

    const filePath = path.join(informationSource.getDirectoryPath(), informationSource.getHash());
    const fileData = await Persistence.read(filePath, storageTargets.LINODE_OBJECT_STORAGE);

    response.setHeader("Content-Type", informationSource.getMimeType() || "application/octet-stream");
    response.setHeader("Content-Disposition", `attachment; filename="${informationSource.getName()}"`);
    response.end(fileData);
}

module.exports = { handleInformationSourceDownload };