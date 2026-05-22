const { PacketronHandlerFlags, PacketronRequestMethod } = require("@gamiumgamers/packetron");
const { ensureLogin } = require("./Plugins/EnsureLogin");
const { getMyActivity } = require("./Activity/GetMyActivity");
const { getActiveTaskProgress } = require("./Activity/GetActiveTaskProgress");


/**
 * Registers the user-facing activity feed endpoints.
 *
 *   POST /Activity/Search             — unified feed (tasks + purchases)
 *   GET  /Activity/Tasks/Progress     — per-task recursive progress tree
 *
 * The invoice endpoint lives under /PaidDecks/Purchases/Invoice and is
 * registered by HandlePaidDeckEndpoints — it's data-adjacent to
 * purchases rather than to the activity feed shell.
 */
function handleActivityEndpoints(server)
{
    server.handle
    ({
        routePath: `/Activity/Search`,
        handler: getMyActivity,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureLogin]
    });

    server.handle
    ({
        routePath: `/Activity/Tasks/Progress`,
        handler: getActiveTaskProgress,
        method: PacketronRequestMethod.GET,
        plugins: [ensureLogin]
    });
}

module.exports = { handleActivityEndpoints };
