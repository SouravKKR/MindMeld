const { getUser } = require("../Helpers/GetUser");
const MetricBadgeManager = require("../../Globals/Classes/Metrics/MetricBadgeManager");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");

/**
 * POST /Metrics/AcknowledgeBadges
 *
 * Body: { category: <MetricBadges category key>, thresholds: [int] }
 *
 * Marks the given milestone badges as celebrated so each celebration shows once
 * (consistent across the user's devices).
 */
async function acknowledgeMetricBadges(request, response)
{
    const user = await getUser(request);

    if (!user)
    {
        response.sendStatusCode(httpStatus.UNAUTHORIZED);
        return;
    }

    const body = await request.getBody();
    const category = typeof body?.category === "string" ? body.category : null;
    const thresholds = Array.isArray(body?.thresholds)
        ? body.thresholds.filter((value) => Number.isFinite(value))
        : null;

    if (!category || !thresholds || thresholds.length === 0)
    {
        response.sendStatusCode(httpStatus.BAD_REQUEST);
        return;
    }

    const metrics = await MetricBadgeManager.acknowledgeBadges(user.getId(), category, thresholds);

    if (!metrics)
    {
        response.sendStatusCode(httpStatus.BAD_REQUEST);
        return;
    }

    response.statusCode = httpStatus.OK;
    response.sendJson({ metrics });
}

module.exports = { acknowledgeMetricBadges };
