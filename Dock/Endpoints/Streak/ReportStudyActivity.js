const { getUser } = require("../Helpers/GetUser");
const StreakManager = require("../../Globals/Classes/Streak/StreakManager");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");

/**
 * POST /Streak/ReportStudyActivity
 *
 * Body: { cardsStudiedToday: int, utcDate: "YYYY-MM-DD" }
 *
 * Reports how many spaced-repetition cards the user has studied today (client
 * UTC), used to satisfy a pending streak recovery. The server never trusts a
 * client-supplied streak — it recomputes from the stored state and only applies
 * the count when the reported UTC date matches the server's today.
 */
async function reportStudyActivity(request, response)
{
    const user = await getUser(request);

    if (!user)
    {
        response.sendStatusCode(httpStatus.UNAUTHORIZED);
        return;
    }

    const body = await request.getBody();
    const cardsStudiedToday = Number.isFinite(body?.cardsStudiedToday) ? Math.floor(body.cardsStudiedToday) : null;
    const utcDate = typeof body?.utcDate === "string" ? body.utcDate : null;

    if (cardsStudiedToday === null || cardsStudiedToday < 0 || !utcDate)
    {
        response.sendStatusCode(httpStatus.BAD_REQUEST);
        return;
    }

    const result = await StreakManager.applyStudyActivity(user.getId(), cardsStudiedToday, utcDate);

    response.statusCode = httpStatus.OK;
    response.sendJson({ streak: result.streak, changed: result.changed, recovered: result.recovered });
}

module.exports = { reportStudyActivity };
