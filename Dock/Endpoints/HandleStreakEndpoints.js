const { PacketronHandlerFlags, PacketronRequestMethod } = require("@gamiumgamers/packetron");
const { ensureLogin } = require("./Plugins/EnsureLogin");
const { acknowledgeBadges } = require("./Streak/AcknowledgeBadges");
const { reportStudyActivity } = require("./Streak/ReportStudyActivity");


/**
 * Registers the login-streak / badge endpoints.
 *
 *   POST /Streak/AcknowledgeBadges    — mark earned badges as celebrated
 *   POST /Streak/ReportStudyActivity  — report today's study count for recovery
 *
 * The streak itself is advanced server-side on GetUser (the app-open trigger).
 * ReportStudyActivity feeds the comeback-day study quota that restores a broken
 * streak; AcknowledgeBadges is the client's "I showed the celebration" hook.
 */
function handleStreakEndpoints(server)
{
    server.handle
    ({
        routePath: `/Streak/AcknowledgeBadges`,
        handler: acknowledgeBadges,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureLogin]
    });

    server.handle
    ({
        routePath: `/Streak/ReportStudyActivity`,
        handler: reportStudyActivity,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureLogin]
    });
}

module.exports = { handleStreakEndpoints };
