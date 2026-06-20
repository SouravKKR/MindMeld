const { PacketronPlugin, PacketronRequest, PacketronResponse } = require("@gamiumgamers/packetron");
const { getSession } = require("../Helpers/GetSession");
const { slideSessionExpiry } = require("../Helpers/SlideSessionExpiry");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");

const ensureLogin = new PacketronPlugin
({
    /**
     * A middleware function that checks if a user is logged in or not.
     * If the user is not logged in, it sends a 401 status code to the client.
     * If the user is logged in, it returns false to indicate that the request can be processed.
     * @param {PacketronRequest} request - The request that is being processed.
     * @param {PacketronResponse} response - The response that is being sent back to the client.
     * @return {Promise<boolean>} A promise that resolves to true if the user is not logged in, false otherwise.
     * @async
     */
    handler: async (request, response) =>
    {
        const session = await getSession(request);
        
        if(!session)
        {
            response.sendStatusCode(httpStatus.UNAUTHORIZED);
            return true;
        }
        else
        {
            request.session = session;
            await slideSessionExpiry(request, response);
            return false;
        }
    }
});

module.exports = { ensureLogin };