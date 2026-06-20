const { getUser } = require("../Helpers/GetUser");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");
const PeriodicCreditReconciler = require("../../Globals/Classes/Credits/PeriodicCreditReconciler");
const StreakManager = require("../../Globals/Classes/Streak/StreakManager");
const AuthenticationQueryEngine = require("../../Globals/Classes/Database/AuthenticationQueryEngine");

async function handleGetUser(request, response)
{
    let user = await getUser(request);

    if(!user)
    {
        response.sendStatusCode(httpStatus.UNAUTHORIZED);
        return;
    }

    // Lazy, pull-based enforcement of periodic credit assignments: querying
    // credits is one of the two trigger points (the other is the AI preflight).
    // Any failure here must never block the GetUser response, so it is fully
    // guarded; on a successful grant we re-fetch so the balance is fresh.
    try
    {
        const email = user.getAdditionalData()?.email || "";
        const reconcileResult = await PeriodicCreditReconciler.reconcileForUser(user.getId(), email);
        if (reconcileResult.creditsGranted > 0)
        {
            const refreshed = await AuthenticationQueryEngine.getUserById(user.getId());
            if (refreshed)
            {
                user = refreshed;
            }
        }
    }
    catch (reconcileError)
    {
        console.warn(`[HandleGetUser] Periodic credit reconcile failed for ${user.getId()}: ${reconcileError?.message || reconcileError}`);
    }

    // Login-based daily streak: GetUser fires on every app bootstrap, so this
    // is the "user is active today" trigger. Idempotent per UTC day. Guarded so
    // a streak failure can never block the response; re-fetch when it changed
    // so the response carries the fresh streak + any newly earned badges.
    try
    {
        const streakResult = await StreakManager.recordDailyActivity(user.getId());
        if (streakResult.changed)
        {
            const refreshed = await AuthenticationQueryEngine.getUserById(user.getId());
            if (refreshed)
            {
                user = refreshed;
            }
        }
    }
    catch (streakError)
    {
        console.warn(`[HandleGetUser] Streak update failed for ${user.getId()}: ${streakError?.message || streakError}`);
    }

    response.statusCode = httpStatus.OK;
    response.sendJson(user.toJson());
}

module.exports = { handleGetUser };
