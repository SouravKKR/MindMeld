const { getUser } = require("../Helpers/GetUser");
const CreditEstimator = require("../../Globals/Classes/Credits/CreditEstimator");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");


/**
 * POST /Generate/EstimateCost
 *
 * Returns an advisory credit-cost estimate for a "Generate with AI" run,
 * computed from the same generation-settings body the /Generate request
 * carries (generalGeneration + the enabled flashcard / studyMaterial /
 * mockTest blocks). Response:
 *
 *   {
 *     estimatedCredits: number | null,   // null when no pricing config exists
 *     low: number, high: number,         // ±band around the estimate
 *     breakdown: [ { label, credits }, ... ],
 *     currency: string | null,
 *     pricePerCredit: number | null
 *   }
 *
 * Advisory only — the per-task charge during execution remains authoritative.
 */
async function handleEstimateCost(request, response)
{
    const user = await getUser(request);
    if (!user)
    {
        response.sendStatusCode(httpStatus.UNAUTHORIZED);
        return;
    }

    const body = await request.getBody();
    const estimate = await CreditEstimator.estimate(body || {});
    response.sendJson(estimate);
}

module.exports = { handleEstimateCost };
