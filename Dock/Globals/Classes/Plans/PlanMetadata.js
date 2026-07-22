const PlanMetadataConstants = require('../../Constants/PlanMetadataConstants');
const { planTiers } = require('../../Enumerations/PlanTiers');
const { planFeatures } = require('../../Enumerations/PlanFeatures');

// The single typed accessor over PlanMetadataConstants. Every plan gate and
// every per-plan limit (storage, devices, sessions, monthly credits, price)
// reads its number from here so the tier truth lives in exactly one place.
//
// Feature access — which AI features a tier unlocks — is the one attribute an
// admin may override at runtime: PlanFeatureConfigurationStore loads overrides
// from the database and calls applyFeatureAccessOverride, and getFeatureSet /
// hasFeature consult that overlay first, falling back to the constant. All
// other attributes are constant-driven and are not overridable.

class PlanMetadata
{
    static #tierNameByValue = null;
    static #featureAccessOverrideByTierName = null;

    static #getTierNameByValue()
    {
        if (PlanMetadata.#tierNameByValue === null)
        {
            const tierNameByValue = {};
            for (const tierName of Object.keys(planTiers))
            {
                tierNameByValue[planTiers[tierName]] = tierName;
            }
            PlanMetadata.#tierNameByValue = tierNameByValue;
        }
        return PlanMetadata.#tierNameByValue;
    }

    static getTierName(tier)
    {
        const tierNameByValue = PlanMetadata.#getTierNameByValue();
        const resolvedName = tierNameByValue[Number(tier)];
        return resolvedName || tierNameByValue[planTiers.FREE];
    }

    static getMetadataForTier(tier)
    {
        const record = PlanMetadataConstants[PlanMetadata.getTierName(tier)];
        if (record)
        {
            return record;
        }
        return PlanMetadataConstants[PlanMetadata.getTierName(planTiers.FREE)];
    }

    static isValidTier(tier)
    {
        return Object.values(planTiers).includes(Number(tier));
    }

    static isPaidTier(tier)
    {
        return PlanMetadata.isValidTier(tier) && Number(tier) !== planTiers.FREE;
    }

    static getAllTiers()
    {
        return PlanMetadataConstants.ORDER
            .map(tierName => planTiers[tierName])
            .filter(value => value !== undefined && value !== null);
    }

    static getLabel(tier)
    {
        return String(PlanMetadata.getMetadataForTier(tier).label || "");
    }

    static getMonthlyCredits(tier)
    {
        return Number(PlanMetadata.getMetadataForTier(tier).monthlyCredits) || 0;
    }

    static getStorageBytes(tier)
    {
        return Number(PlanMetadata.getMetadataForTier(tier).storageBytes) || 0;
    }

    static getMaxDevices(tier)
    {
        return Number(PlanMetadata.getMetadataForTier(tier).maxDevices) || 0;
    }

    static getMaxSessions(tier)
    {
        return Number(PlanMetadata.getMetadataForTier(tier).maxSessions) || 0;
    }

    static getMonthlyFreeDeckCount(tier)
    {
        return Number(PlanMetadata.getMetadataForTier(tier).monthlyFreeDeckCount) || 0;
    }

    static getRazorpayPeriod(tier)
    {
        return String(PlanMetadata.getMetadataForTier(tier).razorpayPeriod || "monthly");
    }

    static getRazorpayInterval(tier)
    {
        return Number(PlanMetadata.getMetadataForTier(tier).razorpayInterval) || 1;
    }

    /**
     * The plan price for a currency in integer minor units, or null when the
     * tier has no configured price in that currency (e.g. FREE, or an
     * unsupported currency).
     * @param {number} tier — planTiers value
     * @param {string} currency — ISO currency code
     * @returns {number|null}
     */
    static getPriceMinor(tier, currency)
    {
        const priceByCurrency = PlanMetadata.getMetadataForTier(tier).priceMinorByCurrency || {};
        const normalizedCurrency = String(currency || "").toUpperCase();
        const value = priceByCurrency[normalizedCurrency];
        return typeof value === "number" ? value : null;
    }

    static getFeatureNamesForTier(tier)
    {
        const tierName = PlanMetadata.getTierName(tier);
        const override = PlanMetadata.#featureAccessOverrideByTierName;
        if (override && Array.isArray(override[tierName]))
        {
            return override[tierName];
        }
        const record = PlanMetadata.getMetadataForTier(tier);
        return Array.isArray(record.features) ? record.features : [];
    }

    /**
     * The PlanFeatures numeric values a tier unlocks, honouring any admin
     * override for feature access.
     * @param {number} tier — planTiers value
     * @returns {number[]}
     */
    static getFeatureSet(tier)
    {
        const featureNumbers = [];
        for (const featureName of PlanMetadata.getFeatureNamesForTier(tier))
        {
            if (Object.prototype.hasOwnProperty.call(planFeatures, featureName))
            {
                featureNumbers.push(planFeatures[featureName]);
            }
        }
        return featureNumbers;
    }

    static hasFeature(tier, feature)
    {
        return PlanMetadata.getFeatureSet(tier).includes(Number(feature));
    }

    /**
     * Overlays an admin-configured feature-access map (tier NAME → array of
     * PlanFeatures names). Passing a non-object is ignored so a failed load
     * never wipes the working overlay.
     * @param {object} overrideByTierName
     */
    static applyFeatureAccessOverride(overrideByTierName)
    {
        if (overrideByTierName && typeof overrideByTierName === "object")
        {
            PlanMetadata.#featureAccessOverrideByTierName = overrideByTierName;
        }
    }

    static clearFeatureAccessOverride()
    {
        PlanMetadata.#featureAccessOverrideByTierName = null;
    }
}

module.exports = PlanMetadata;
