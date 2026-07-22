const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const PlanMetadata = require("./PlanMetadata");
const PlanMetadataConstants = require("../../Constants/PlanMetadataConstants");
const { planFeatures } = require("../../Enumerations/PlanFeatures");

// The admin-editable overlay for "which plan tier unlocks which AI feature".
// Stored as a singleton doc { featureAccessByTierName: { TIER_NAME: [name,…] } }
// and applied to PlanMetadata so PlanEntitlementGate honours it without a
// redeploy. A short TTL cache (like CreditConfigurationStore) keeps hot-path
// gate checks cheap. When unset, PlanMetadataConstants defaults are in effect.

class PlanFeatureConfigurationStore
{
    static #DOCUMENT_ID = "global";
    static #CACHE_TTL_MILLISECONDS = 15 * 1000;
    static #cachedConfig = null;
    static #cachedAtMilliseconds = 0;
    static #hasCached = false;

    static async #getCollection()
    {
        return (await DatabaseConnector.getDatabase())
            .collection(DatabaseConstants.PLAN_FEATURE_CONFIG_COLLECTION);
    }

    /**
     * Loads the override map, applies it to PlanMetadata, and caches it. Returns
     * the map, or null when unset (constant defaults in effect). Guarded so a
     * load failure leaves the last-known override in place.
     * @returns {Promise<object|null>}
     */
    static async load()
    {
        const now = Date.now();
        if (PlanFeatureConfigurationStore.#hasCached && (now - PlanFeatureConfigurationStore.#cachedAtMilliseconds) < PlanFeatureConfigurationStore.#CACHE_TTL_MILLISECONDS)
        {
            return PlanFeatureConfigurationStore.#cachedConfig;
        }

        let override = null;
        try
        {
            const collection = await PlanFeatureConfigurationStore.#getCollection();
            const document = await collection.findOne({ _id: PlanFeatureConfigurationStore.#DOCUMENT_ID });
            if (document && document.featureAccessByTierName && typeof document.featureAccessByTierName === "object")
            {
                override = document.featureAccessByTierName;
            }
        }
        catch (loadError)
        {
            console.warn(`[PlanFeatureConfigurationStore] Load failed: ${loadError?.message || loadError}`);
            return PlanFeatureConfigurationStore.#cachedConfig;
        }

        if (override)
        {
            PlanMetadata.applyFeatureAccessOverride(override);
        }
        else
        {
            PlanMetadata.clearFeatureAccessOverride();
        }
        PlanFeatureConfigurationStore.#cachedConfig = override;
        PlanFeatureConfigurationStore.#cachedAtMilliseconds = now;
        PlanFeatureConfigurationStore.#hasCached = true;
        return override;
    }

    /**
     * The effective feature map for the admin editor: the override if set, else
     * the constant defaults, for every tier. Shape { TIER_NAME: [featureName] }.
     */
    static async getEffectiveConfig()
    {
        const override = await PlanFeatureConfigurationStore.load();
        const effective = {};
        for (const tierName of PlanMetadataConstants.ORDER)
        {
            if (override && Array.isArray(override[tierName]))
            {
                effective[tierName] = override[tierName].slice();
            }
            else
            {
                effective[tierName] = (PlanMetadataConstants[tierName].features || []).slice();
            }
        }
        return effective;
    }

    /**
     * Persists a validated override map (only known tier + feature names kept)
     * and applies it immediately.
     * @param {object} featureAccessByTierName
     */
    static async save(featureAccessByTierName)
    {
        const validFeatureNames = new Set(Object.keys(planFeatures));
        const sanitized = {};
        for (const tierName of PlanMetadataConstants.ORDER)
        {
            const requested = Array.isArray(featureAccessByTierName?.[tierName]) ? featureAccessByTierName[tierName] : [];
            sanitized[tierName] = requested.filter(featureName => validFeatureNames.has(featureName));
        }

        const collection = await PlanFeatureConfigurationStore.#getCollection();
        await collection.updateOne
        (
            { _id: PlanFeatureConfigurationStore.#DOCUMENT_ID },
            { $set: { featureAccessByTierName: sanitized, updatedAt: new Date() } },
            { upsert: true }
        );

        PlanMetadata.applyFeatureAccessOverride(sanitized);
        PlanFeatureConfigurationStore.#cachedConfig = sanitized;
        PlanFeatureConfigurationStore.#cachedAtMilliseconds = Date.now();
        PlanFeatureConfigurationStore.#hasCached = true;
        return { success: true, featureAccessByTierName: sanitized };
    }
}

module.exports = PlanFeatureConfigurationStore;
