const { PacketronRequest, PacketronResponse } = require("@gamiumgamers/packetron");
const { getUser } = require("../Helpers/GetUser");
const InformationSourceQueryEngine = require("../../Globals/Classes/Database/InformationSourceQueryEngine");

/**
 * Returns all information source metadata objects belonging to the authenticated user.
 * Does not download any files — metadata only.
 *
 * @param {PacketronRequest} request - The request object.
 * @param {PacketronResponse} response - The response object.
 * @returns {Promise} A promise that resolves when the response is sent.
 */
async function handleListInformationSourcesForUser(request, response)
{
    const user = await getUser(request);

    const informationSources = await InformationSourceQueryEngine.getInformationSourcesByUserId(user.getId());

    response.sendJson(informationSources.map(informationSource => informationSource.toJson()));
}

module.exports = { handleListInformationSourcesForUser };