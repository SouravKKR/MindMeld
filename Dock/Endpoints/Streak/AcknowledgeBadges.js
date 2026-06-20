const { getUser } = require("../Helpers/GetUser");
const StreakManager = require("../../Globals/Classes/Streak/StreakManager");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");

/**
 * POST /Streak/AcknowledgeBadges
 *
 * Body: { streaks: [<badge streak threshold>, ...] }
 *
 * Marks the given earned badges as acknowledged so their celebration is shown
 * exactly once for the account (and stays consistent across the user's
 * devices). Returns the updated streak state.
 */
async function acknowledgeBadges(request, response)
{
    const user = await getUser(request);

    if (!user)
    {
        response.sendStatusCode(httpStatus.UNAUTHORIZED);
        return;
    }

    const body = await request.getBody();
    const streaks = Array.isArray(body?.streaks)
        ? body.streaks.filter((value) => Number.isFinite(value))
        : null;

    if (!streaks || streaks.length === 0)
    {
        response.sendStatusCode(httpStatus.BAD_REQUEST);
        return;
    }

    const updatedStreak = await StreakManager.acknowledgeBadges(user.getId(), streaks);

    if (!updatedStreak)
    {
        response.sendStatusCode(httpStatus.INTERNAL_SERVER_ERROR);
        return;
    }

    response.sendJson({ streak: updatedStreak });
}

module.exports = { acknowledgeBadges };
