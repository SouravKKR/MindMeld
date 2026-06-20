const { getUser } = require("../Helpers/GetUser");
const LeaderboardService = require("../../Globals/Classes/Metrics/LeaderboardService");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");

/**
 * GET /Leaderboard/Me
 *
 * Returns the requesting user's standing on the composite-XP world leaderboard:
 * { score, rank, totalUsers, topPercent, inTopThousand }. The client shows
 * "top topPercent%" always and the exact rank only when inTopThousand.
 */
async function getLeaderboard(request, response)
{
    const user = await getUser(request);

    if (!user)
    {
        response.sendStatusCode(httpStatus.UNAUTHORIZED);
        return;
    }

    const standing = await LeaderboardService.getRankFor(user);

    response.statusCode = httpStatus.OK;
    response.sendJson(standing);
}

module.exports = { getLeaderboard };
