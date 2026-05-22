const authenticationProviders = require("../Globals/Enumerations/AuthenticationProviders");
const { Packetron, PacketronHandlerFlags, PacketronRequestMethod } = require("@gamiumgamers/packetron");
const { handleGenerate } = require("./AutomaticGeneration/Generate");
const { handleInformationSourceUpload } = require("./AutomaticGeneration/InformationSourceUpload");
const { handleListInformationSourcesForUser } = require("./AutomaticGeneration/ListInformationSourcesForUser");
const { handleInformationSourceDownload } = require("./AutomaticGeneration/InformationSourceDownload");
const { handleGetProgress } = require("./AutomaticGeneration/GetProgress");
const { handleTemplatesSearch } = require("./AutomaticGeneration/TemplatesSearch");
const { handleTemplatesGet } = require("./AutomaticGeneration/TemplatesGet");
const { ensureLogin } = require("./Plugins/EnsureLogin");

/**
 * Registers authentication-related endpoints on the server.
 *
 * Iterates over all configured authentication providers and attaches
 * their respective endpoints to the given server instance.
 *
 * @param {Packetron} server
 * An instance of the Packetron server on which endpoints will be registered.
 *
 * @returns {void}
 */
function handleAutomaticGenerationEndpoints(server)
{
    server.handle
    ({
        routePath: `/Generate`,
        handler: handleGenerate,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ ensureLogin ]
    });

    server.handle
    ({
        routePath: `/InformationSource/Upload`,
        handler: handleInformationSourceUpload,
        flags: PacketronHandlerFlags.FILE_UPLOAD,
        method: PacketronRequestMethod.POST,
        plugins: [ ensureLogin ]
    });

    server.handle
    ({
        routePath: `/InformationSource/List`,
        handler: handleListInformationSourcesForUser,
        method: PacketronRequestMethod.GET,
        plugins: [ ensureLogin ]
    });

    server.handle
    ({
        routePath: `/InformationSource/Download`,
        handler: handleInformationSourceDownload,
        method: PacketronRequestMethod.GET,
        plugins: [ ensureLogin ]
    });

    server.handle(
    {
        routePath: `/Generate/Progress`,
        handler: handleGetProgress,
        method: PacketronRequestMethod.GET,
        plugins: [ensureLogin],
    });

    server.handle(
    {
        routePath: `/Templates/Search`,
        handler: handleTemplatesSearch,
        method: PacketronRequestMethod.GET,
        plugins: [ensureLogin],
    });

    server.handle(
    {
        routePath: `/Templates/Get`,
        handler: handleTemplatesGet,
        method: PacketronRequestMethod.GET,
        plugins: [ensureLogin],
    });
}

module.exports = { handleAutomaticGenerationEndpoints };