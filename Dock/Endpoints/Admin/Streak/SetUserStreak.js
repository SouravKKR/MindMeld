const AuthenticationQueryEngine = require("../../../Globals/Classes/Database/AuthenticationQueryEngine");
const StreakManager = require("../../../Globals/Classes/Streak/StreakManager");
const {httpStatus} = require("../../../Globals/Enumerations/HttpStatus");

/**
 * POST /Admin/Streak/SetUserStreak  (admin only)
 *
 * Body: { userIdentifier, action: "set" | "reset",
 *         current?, longest?, lastActiveDate?, celebrateOnNextLaunch? }
 *
 * Testing tool: set or reset any user's login streak. `userIdentifier` may be a
 * userId or an email. When `celebrateOnNextLaunch` is true on a "set", the
 * highest earned badge is left unacknowledged so its celebration (and tier
 * sound) plays on that user's next launch — letting the admin preview it.
 */
async function setUserStreak(request, response)
{
    let body;
    try
    {
        body = await request.getBody();
    }
    catch (bodyError)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: "Malformed JSON body." });
        return;
    }

    const userIdentifier = typeof body?.userIdentifier === "string" ? body.userIdentifier.trim() : "";
    const action = body?.action === "reset" ? "reset" : "set";

    if (userIdentifier.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: "A user id or email is required." });
        return;
    }

    let targetUser = await AuthenticationQueryEngine.getUserById(userIdentifier);
    if (!targetUser)
    {
        targetUser = await AuthenticationQueryEngine.getUserByEmail(userIdentifier);
    }

    if (!targetUser)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ error: "No user found for that id or email." });
        return;
    }

    let streak;
    if (action === "reset")
    {
        streak = await StreakManager.adminResetStreak(targetUser.getId());
    }
    else
    {
        streak = await StreakManager.adminSetStreak(targetUser.getId(),
        {
            current: body?.current,
            longest: body?.longest,
            lastActiveDate: typeof body?.lastActiveDate === "string" ? body.lastActiveDate : undefined,
            celebrateOnNextLaunch: body?.celebrateOnNextLaunch === true,
        });
    }

    if (!streak)
    {
        response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
        response.sendJson({ error: "Failed to update streak." });
        return;
    }

    response.statusCode = httpStatus.OK;
    response.sendJson({ success: true, userId: targetUser.getId(), streak: streak });
}

module.exports = { setUserStreak };
