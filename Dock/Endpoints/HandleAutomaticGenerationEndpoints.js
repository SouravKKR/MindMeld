const authenticationProviders = require("../Globals/Enumerations/AuthenticationProviders");
const { Packetron, PacketronHandlerFlags, PacketronRequestMethod } = require("@gamiumgamers/packetron");
const { handleGenerate } = require("./AutomaticGeneration/Generate");
const { handleEstimateCost } = require("./AutomaticGeneration/EstimateCost");
const { handleAutoFillOptions } = require("./AutomaticGeneration/AutoFillOptions");
const { handleInformationSourceUpload } = require("./AutomaticGeneration/InformationSourceUpload");
const { handleListInformationSourcesForUser } = require("./AutomaticGeneration/ListInformationSourcesForUser");
const { handleInformationSourceDownload } = require("./AutomaticGeneration/InformationSourceDownload");
const { handleInformationSourceDelete } = require("./AutomaticGeneration/InformationSourceDelete");
const { handleGetProgress } = require("./AutomaticGeneration/GetProgress");
const { handlePauseGeneration } = require("./AutomaticGeneration/PauseGeneration");
const { handleTemplatesSearch } = require("./AutomaticGeneration/TemplatesSearch");
const { handleTemplatesGet } = require("./AutomaticGeneration/TemplatesGet");
const { beautifyDeckShortNames } = require("./AutomaticGeneration/BeautifyDeckShortNames");
const { getBeautifiedShortNames } = require("./AutomaticGeneration/GetBeautifiedShortNames");
const { ensureLogin } = require("./Plugins/EnsureLogin");
const { ensureEstimateCostRateLimit } = require("./Plugins/EnsureEstimateCostRateLimit");

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
        routePath: `/Generate/EstimateCost`,
        handler: handleEstimateCost,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        // The limiter must follow ensureLogin: it keys on the resolved user.
        plugins: [ ensureLogin, ensureEstimateCostRateLimit ]
    });

    // "Auto Fill Other Options" helper — recommends generation option values from
    // the entered subject/exam/instructions. Credit-metered like the AskAi tiers
    // (it bypasses the task queue; the runner does the preflight + charge).
    server.handle
    ({
        routePath: `/Generate/AutoFillOptions`,
        handler: handleAutoFillOptions,
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

    server.handle
    ({
        routePath: `/InformationSource/Delete`,
        handler: handleInformationSourceDelete,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
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
        routePath: `/Generate/Pause`,
        handler: handlePauseGeneration,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
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

    // Manual deck short-name beautifier — open to any signed-in user. The
    // BEAUTIFY_DECK_SHORT_NAMES task carries the user id, so the Agent's
    // per-task credit charger bills it like any other metered AI feature.
    server.handle(
    {
        routePath: `/Decks/BeautifyShortNames`,
        handler: beautifyDeckShortNames,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureLogin],
    });

    server.handle(
    {
        routePath: `/Decks/BeautifyShortNames/Result`,
        handler: getBeautifiedShortNames,
        method: PacketronRequestMethod.GET,
        plugins: [ensureLogin],
    });
}

module.exports = { handleAutomaticGenerationEndpoints };