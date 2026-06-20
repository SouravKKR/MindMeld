const { getUser } = require("../Helpers/GetUser");
const MetricBadgeManager = require("../../Globals/Classes/Metrics/MetricBadgeManager");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");

/**
 * POST /Metrics/Report
 *
 * Body: { increments: { cardsStudied?, mockTestsTaken?, minutesStudied?, doubtsAsked? } }
 *
 * Applies the client's batched, throttled increments. The server clamps each to
 * what is physically possible since the user's last report and awards any
 * newly-crossed milestone badges. Returns the updated metrics + new awards.
 */
async function reportMetrics(request, response)
{
    const user = await getUser(request);

    if (!user)
    {
        response.sendStatusCode(httpStatus.UNAUTHORIZED);
        return;
    }

    const body = await request.getBody();
    const increments = body?.increments;

    if (!increments || typeof increments !== "object")
    {
        response.sendStatusCode(httpStatus.BAD_REQUEST);
        return;
    }

    const result = await MetricBadgeManager.applyIncrements(user.getId(), increments);

    response.statusCode = httpStatus.OK;
    response.sendJson({ metrics: result.metrics, newlyAwarded: result.newlyAwarded });
}

module.exports = { reportMetrics };
