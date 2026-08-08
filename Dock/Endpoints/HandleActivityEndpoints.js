const { PacketronHandlerFlags, PacketronRequestMethod } = require("@gamiumgamers/packetron");
const { ensureLogin } = require("./Plugins/EnsureLogin");
const { getMyActivity } = require("./Activity/GetMyActivity");
const { getActiveTaskProgress } = require("./Activity/GetActiveTaskProgress");
const { getGenerationCreditSummary } = require("./Activity/GetGenerationCreditSummary");
const { recordDailyUsage } = require("./Activity/RecordDailyUsage");


/**
 * Registers the user-facing activity feed endpoints.
 *
 *   POST /Activity/Search             — unified feed (tasks + purchases)
 *   GET  /Activity/Tasks/Progress     — per-task recursive progress tree
 *   POST /Activity/RecordDailyUsage   — device-reported study rollup
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

    server.handle
    ({
        routePath: `/Activity/Tasks/CreditSummary`,
        handler: getGenerationCreditSummary,
        method: PacketronRequestMethod.GET,
        plugins: [ensureLogin]
    });

    // The two study actions the server cannot date for itself. Attributed to
    // the caller's active scope, resolved server-side — a client naming its own
    // organization would let a member post activity into an institute they have
    // no standing in.
    server.handle
    ({
        routePath: `/Activity/RecordDailyUsage`,
        handler: recordDailyUsage,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureLogin]
    });
}

module.exports = { handleActivityEndpoints };
