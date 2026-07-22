const PlanFeatureConfigurationStore = require("../../../Globals/Classes/Plans/PlanFeatureConfigurationStore");
const PlanMetadataConstants = require("../../../Globals/Constants/PlanMetadataConstants");
const { planFeatures } = require("../../../Globals/Enumerations/PlanFeatures");
const { httpStatus } = require("../../../Globals/Enumerations/HttpStatus");

/**
 * GET /Admin/Plans/Features/Get
 *
 * Returns the effective plan → AI-feature access matrix (admin override if set,
 * else the constant defaults) plus the tier and feature vocabularies the editor
 * renders.
 */
async function getPlanFeatureConfig(request, response)
{
    const featureAccessByTierName = await PlanFeatureConfigurationStore.getEffectiveConfig();

    const tierLabels = {};
    for (const tierName of PlanMetadataConstants.ORDER)
    {
        tierLabels[tierName] = PlanMetadataConstants[tierName].label;
    }

    response.statusCode = httpStatus.OK;
    response.sendJson
    ({
        featureAccessByTierName: featureAccessByTierName,
        tiers: PlanMetadataConstants.ORDER,
        tierLabels: tierLabels,
        allFeatures: Object.keys(planFeatures)
    });
}

module.exports = { getPlanFeatureConfig };
