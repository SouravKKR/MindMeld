const { PacketronPlugin } = require("@gamiumgamers/packetron");

const noCache = new PacketronPlugin
({
    /**
     * Sets the header "Cache-Control" to "no-store" in the given response.
     * This is necessary because packetron serves files from the file system and does not know
     * how long the files will be valid. Therefore, the browser should not cache the files.
     * @param {PacketronRequest} request - The request that is being processed.
     * @param {PacketronResponse} response - The response that is being sent back to the client.
     */
    handler: (request, response)=>
    {
        response.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0");
        response.setHeader("Pragma", "no-cache");
        response.setHeader("Expires", "0");
        response.setHeader("Surrogate-Control", "no-store");
    }
});

module.exports = { noCache };