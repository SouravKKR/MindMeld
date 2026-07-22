const PlanFeatureConfigurationStore = require("../../../Globals/Classes/Plans/PlanFeatureConfigurationStore");
const ErrorCodes = require("../../../Globals/Constants/ErrorCodes");
const { httpStatus } = require("../../../Globals/Enumerations/HttpStatus");

/**
 * POST /Admin/Plans/Features/Save
 *
 * Persists which AI features each plan tier unlocks. Only known tier and feature
 * names are kept; the override applies immediately (PlanEntitlementGate honours
 * it on the next check).
 *
 * Body: { featureAccessByTierName: { TIER_NAME: [featureName, ...] } }
 */
async function setPlanFeatureConfig(request, response)
{
    const body = await request.getBody();
    const featureAccessByTierName = body?.featureAccessByTierName;

    if (!featureAccessByTierName || typeof featureAccessByTierName !== "object")
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_BODY });
        return;
    }

    const result = await PlanFeatureConfigurationStore.save(featureAccessByTierName);

    response.statusCode = httpStatus.OK;
    response.sendJson({ success: true, featureAccessByTierName: result.featureAccessByTierName });
}

module.exports = { setPlanFeatureConfig };
