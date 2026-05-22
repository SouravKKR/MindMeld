const { PacketronRequest, PacketronResponse } = require("@gamiumgamers/packetron");
const { getUser } = require("../Helpers/GetUser");
const AuthenticationQueryEngine = require("../../Globals/Classes/Database/AuthenticationQueryEngine");
const Persistence = require("../../Globals/Classes/Persistence");
const { storageTargets } = require("../../Globals/Enumerations/StorageTargets");
const path = require("path");

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

    const informationSource = await AuthenticationQueryEngine.getInformationSourceById(informationSourceId);

    if (informationSource === null)
    {
        response.statusCode = 404;
        response.end("Information source not found.");
        return;
    }

    const userOwnsSource = await AuthenticationQueryEngine.doesUserOwnInformationSourceWithHash(user.getId(), informationSource.getHash());

    if (!userOwnsSource)
    {
        response.statusCode = 403;
        response.end("You do not have permission to access this information source.");
        return;
    }

    const filePath = path.join(informationSource.getDirectoryPath(), informationSource.getHash());
    const fileData = await Persistence.read(filePath, storageTargets.GOOGLE_CLOUD_STORAGE);

    response.setHeader("Content-Type", informationSource.getMimeType() || "application/octet-stream");
    response.setHeader("Content-Disposition", `attachment; filename="${informationSource.getName()}"`);
    response.end(fileData);
}

module.exports = { handleInformationSourceDownload };