const { PacketronHandlerFlags, PacketronRequestMethod } = require("@gamiumgamers/packetron");
const { ensureLogin } = require("./Plugins/EnsureLogin");
const { ensureMetricsRateLimit } = require("./Plugins/EnsureMetricsRateLimit");
const { syncMetrics } = require("./Metrics/SyncMetrics");
const { acknowledgeMetricBadges } = require("./Metrics/AcknowledgeMetricBadges");
const { getLeaderboard } = require("./Metrics/GetLeaderboard");


/**
 * Registers the achievement-metric + leaderboard endpoints.
 *
 *   POST /Metrics/Sync              — apply minutes/doubts increments + recompute
 *                                     cards/mock tests from Mongo (throttled)
 *   POST /Metrics/AcknowledgeBadges — mark milestone badges celebrated
 *   GET  /Leaderboard/Me            — composite-XP rank / percentile
 *
 * /Metrics/Sync carries a dedicated per-user rate limit; cards/mock tests are
 * recomputed server-side from the user's entities (clients can't inflate them).
 */
function handleMetricsEndpoints(server)
{
    server.handle
    ({
        routePath: `/Metrics/Sync`,
        handler: syncMetrics,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureLogin, ensureMetricsRateLimit]
    });

    server.handle
    ({
        routePath: `/Metrics/AcknowledgeBadges`,
        handler: acknowledgeMetricBadges,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureLogin]
    });

    server.handle
    ({
        routePath: `/Leaderboard/Me`,
        handler: getLeaderboard,
        method: PacketronRequestMethod.GET,
        plugins: [ensureLogin]
    });
}

module.exports = { handleMetricsEndpoints };
