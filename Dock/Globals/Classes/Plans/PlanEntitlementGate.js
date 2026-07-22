const AuthenticationQueryEngine = require('../Database/AuthenticationQueryEngine');
const PlanMetadata = require('./PlanMetadata');
const PlanTierResolver = require('./PlanTierResolver');
const { planTiers } = require('../../Enumerations/PlanTiers');
const ErrorCodes = require('../../Constants/ErrorCodes');

// The authoritative server-side check for "may this account use this AI
// feature". Each metered AI endpoint calls this BEFORE the credit preflight so
// a user on a tier that does not include the feature is refused with
// FEATURE_NOT_IN_PLAN (403) rather than the credit-shaped PAYMENT_REQUIRED
// (402). Feature access honours any admin override loaded into PlanMetadata;
// the client's plan value is never trusted.

class PlanEntitlementGate
{
    /**
     * Synchronous check against an already-resolved User instance.
     * @param {User|null} user
     * @param {number} planFeature — PlanFeatures value
     * @returns {{allowed: boolean, currentTier: number, requiredTier: number|null, reason: string}}
     */
    static evaluateForUser(user, planFeature)
    {
        const currentTier = user ? PlanTierResolver.getEffectiveTier(user) : planTiers.FREE;
        const allowed = PlanMetadata.hasFeature(currentTier, planFeature);
        return {
            allowed: allowed,
            currentTier: currentTier,
            requiredTier: PlanEntitlementGate.#minimumTierForFeature(planFeature),
            reason: allowed ? "OK" : ErrorCodes.FEATURE_NOT_IN_PLAN,
        };
    }

    /**
     * Loads the user and checks the feature. Returns INVALID_REQUEST when the
     * id is missing so a wiring bug never silently passes the gate.
     * @param {string} userId
     * @param {number} planFeature — PlanFeatures value
     * @returns {Promise<{allowed: boolean, currentTier: number, requiredTier: number|null, reason: string}>}
     */
    static async requireFeature(userId, planFeature)
    {
        if (typeof userId !== "string" || userId.length === 0)
        {
            return {
                allowed: false,
                currentTier: planTiers.FREE,
                requiredTier: PlanEntitlementGate.#minimumTierForFeature(planFeature),
                reason: ErrorCodes.INVALID_REQUEST,
            };
        }

        // Refresh the admin feature-access override into PlanMetadata (cached,
        // so this is a no-op most calls). Lazy-required to avoid a require cycle;
        // guarded so a config-load failure never blocks a legitimate request.
        try
        {
            const PlanFeatureConfigurationStore = require("./PlanFeatureConfigurationStore");
            await PlanFeatureConfigurationStore.load();
        }
        catch (configError)
        {
            console.warn(`[PlanEntitlementGate] Feature-config load failed: ${configError?.message || configError}`);
        }

        const user = await AuthenticationQueryEngine.getUserById(userId);
        return PlanEntitlementGate.evaluateForUser(user, planFeature);
    }

    // The lowest tier (by ordinal) that unlocks the feature — surfaced to the
    // client so it can render "Upgrade to <tier>". Honours admin overrides.
    static #minimumTierForFeature(planFeature)
    {
        for (const tier of PlanMetadata.getAllTiers())
        {
            if (PlanMetadata.hasFeature(tier, planFeature))
            {
                return tier;
            }
        }
        return null;
    }
}

module.exports = PlanEntitlementGate;
