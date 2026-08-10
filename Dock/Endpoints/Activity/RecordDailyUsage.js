const { getUser } = require("../Helpers/GetUser");
const UserDailyActivityQueryEngine = require("../../Globals/Classes/Database/UserDailyActivityQueryEngine");
const ViewScopeResolver = require("../../Globals/Classes/View/ViewScopeResolver");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");

/**
 * POST /Activity/RecordDailyUsage
 *
 * Body: { dayUtc: "YYYY-MM-DD", counters: { cardsStudied, studyMaterialsViewed } }
 *
 * Records the two study actions the server cannot date for itself. Card reviews
 * survive only as the 20 most recent points per card, and study-material views
 * are a bare counter — both happen entirely in the browser, so a device report
 * is the only way "usage over time" can answer for them at all.
 *
 * Follows the precedent of /Streak/ReportStudyActivity, which already accepts a
 * client-reported card count. As there, the client is not trusted with anything
 * consequential: nothing here affects a balance, an entitlement or a grade, and
 * every surface that displays these counts labels them as device-reported.
 *
 * SCOPE, NOT ACCOUNT. The row is keyed by the caller's active scope, so study
 * done inside an organization view is attributed to that organization and
 * personal study is not. The scope is resolved server-side from the request's
 * own context header via the same resolver /Sync uses — a client naming its own
 * organization would let a member post activity into an institute they have no
 * standing in.
 *
 * THREE CLAMPS, all deliberate:
 *   - a day more than one day ahead of the server's today is refused, so a
 *     device with a wrong clock cannot write into the future where no report
 *     window will ever show it for review;
 *   - a day older than the backfill horizon is refused, so a replayed report
 *     cannot rewrite months of history;
 *   - each counter is capped per request, so a crafted payload inflates a day
 *     by a bounded amount rather than without limit.
 */
const MAXIMUM_COUNTER_VALUE_PER_REQUEST = 2000;
const MAXIMUM_BACKFILL_DAYS = 2;
const MAXIMUM_FUTURE_DAYS = 1;

async function recordDailyUsage(request, response)
{
    const user = await getUser(request);

    if (!user)
    {
        response.sendStatusCode(httpStatus.UNAUTHORIZED);
        return;
    }

    const body = await request.getBody();
    const dayUtc = typeof body?.dayUtc === "string" ? body.dayUtc : "";

    if (!UserDailyActivityQueryEngine.isValidDayUtc(dayUtc) || !isDayWithinAcceptedWindow(dayUtc))
    {
        response.sendStatusCode(httpStatus.BAD_REQUEST);
        return;
    }

    const counters = {};

    for (const counterName of UserDailyActivityQueryEngine.COUNTER_NAMES)
    {
        const reportedValue = Number(body?.counters ? body.counters[counterName] : 0);

        if (Number.isFinite(reportedValue) && reportedValue > 0)
        {
            counters[counterName] = Math.min(Math.floor(reportedValue), MAXIMUM_COUNTER_VALUE_PER_REQUEST);
        }
    }

    const scope = await ViewScopeResolver.resolve(request, user.getId(), user);

    const bRecorded = await UserDailyActivityQueryEngine.recordDailyUsage
    ({
        scopeKey: scope.scopeKey,
        accountUserId: user.getId(),
        organizationId: scope.organizationId || "",
        dayUtc: dayUtc,
        counters: counters,
    });

    response.statusCode = httpStatus.OK;
    response.sendJson({ success: true, recorded: bRecorded });
}

/**
 * True when the reported day is close enough to the server's today to be a
 * plausible report from a device rather than a rewrite of history.
 *
 * The window is generous in both directions on purpose: a device an hour behind
 * UTC legitimately reports yesterday, and a session that spans midnight
 * legitimately flushes a day late.
 */
function isDayWithinAcceptedWindow(dayUtc)
{
    const reportedDayMilliseconds = new Date(`${dayUtc}T00:00:00.000Z`).getTime();
    const todayMilliseconds = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`).getTime();
    const dayLengthMilliseconds = 24 * 60 * 60 * 1000;

    const differenceInDays = (reportedDayMilliseconds - todayMilliseconds) / dayLengthMilliseconds;

    return differenceInDays <= MAXIMUM_FUTURE_DAYS && differenceInDays >= -MAXIMUM_BACKFILL_DAYS;
}

module.exports = { recordDailyUsage };
