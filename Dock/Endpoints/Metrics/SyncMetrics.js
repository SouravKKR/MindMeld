const { getUser } = require("../Helpers/GetUser");
const MetricBadgeManager = require("../../Globals/Classes/Metrics/MetricBadgeManager");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");

/**
 * POST /Metrics/Sync
 *
 * Body: { increments?: { minutesStudied?, doubtsAsked? } }
 *
 * Single low-frequency call (fired at study/mock boundaries + login): applies
 * the client-reported minutes/doubts increments AND recomputes cards / mock
 * tests authoritatively from the user's Mongo entities (throttled). Returns the
 * updated metrics + any newly-earned milestone badges. An empty body is valid —
 * it just triggers the (throttled) recompute.
 */
async function syncMetrics(request, response)
{
    const user = await getUser(request);

    if (!user)
    {
        response.sendStatusCode(httpStatus.UNAUTHORIZED);
        return;
    }

    const body = await request.getBody();
    const increments = body?.increments && typeof body.increments === "object" ? body.increments : {};

    const result = await MetricBadgeManager.syncMetrics(user.getId(), increments);

    response.statusCode = httpStatus.OK;
    response.sendJson({ metrics: result.metrics, newlyAwarded: result.newlyAwarded });
}

module.exports = { syncMetrics };
