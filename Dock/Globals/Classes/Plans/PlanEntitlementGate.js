const AuthenticationQueryEngine = require('../Database/AuthenticationQueryEngine');
const PlanMetadata = require('./PlanMetadata');
const PlanTierResolver = require('./PlanTierResolver');
const ViewScopeResolver = require('../View/ViewScopeResolver');
const OrganizationFeatureResolver = require('../Organization/OrganizationFeatureResolver');
const { planTiers } = require('../../Enumerations/PlanTiers');
const ErrorCodes = require('../../Constants/ErrorCodes');

// The authoritative server-side check for "may this account use this AI
// feature". Each metered AI endpoint calls this BEFORE the credit preflight so
// a user on a tier that does not include the feature is refused with
// FEATURE_NOT_IN_PLAN (403) rather than the credit-shaped PAYMENT_REQUIRED
// (402). Feature access honours any admin override loaded into PlanMetadata;
// the client's plan value is never trusted.
//
// Inside an ORGANIZATION VIEW the question changes: what the member may do is
// decided by that organization's permission rules rather than by the plan they
// personally pay for. That is the whole point of the separation — an institute
// grants capability inside its own world without upgrading anyone's private
// account, and a member's own subscription is neither consumed nor extended by
// working there. requireFeatureForRequest is the entry point that knows which
// world a request is in; requireFeature remains the personal-only check for the
// paths that have no request to read.
//
// Inside an administrator's SIMULATED PLAN VIEW the question changes again, to
// "what would this tier allow" — evaluated in both directions, so a Pro Plus
// administrator looking at the Free view is refused exactly as a Free user would
// be. See #evaluateForPlanView. That branch grants and withholds FEATURES only;
// nothing about it touches credits, subscriptions or payments, which key on the
// real account and never come through here.

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

    /**
     * The request-aware check. Resolves which view the request is in and
     * evaluates against that world's rules.
     *
     * The organization context is re-authorised inside OrganizationScopeResolver
     * on every call, so a header naming an organization the caller does not
     * belong to falls back to their personal plan rather than granting anything.
     *
     * @param {object} request
     * @param {string} userId
     * @param {number} planFeature a PlanFeatures value
     * @returns {Promise<{allowed: boolean, currentTier: number, requiredTier: number|null, reason: string, organizationId: string|null}>}
     */
    static async requireFeatureForRequest(request, userId, planFeature)
    {
        const scope = await ViewScopeResolver.resolve(request, userId);

        if (scope.planViewTierName.length > 0)
        {
            return await PlanEntitlementGate.#evaluateForPlanView(scope, planFeature);
        }

        if (scope.organizationId === null)
        {
            return { ...await PlanEntitlementGate.requireFeature(userId, planFeature), organizationId: null, planViewTierName: "" };
        }

        const user = await AuthenticationQueryEngine.getUserById(userId);
        const entitlement = await OrganizationFeatureResolver.resolveForMember
        (
            scope.organization,
            userId,
            user ? (user.getAdditionalData()?.email || "") : ""
        );

        const bAllowed = entitlement.featureValues.includes(Number(planFeature));

        return {
            allowed: bAllowed,
            // The tier is reported as the personal one because that is what it
            // still is — the organization grants features, not a tier — and a
            // client showing "upgrade to Pro" for a feature the INSTITUTE
            // controls would send the member to the wrong place.
            currentTier: user ? PlanTierResolver.getEffectiveTier(user) : planTiers.FREE,
            requiredTier: null,
            reason: bAllowed ? "OK" : ErrorCodes.FEATURE_NOT_IN_PLAN,
            organizationId: scope.organizationId,
            planViewTierName: ""
        };
    }

    /**
     * The answer inside an administrator's simulated plan sandbox: what would
     * THIS TIER allow, not what does this account pay for.
     *
     * It binds in BOTH directions, and that is the point. A simulation that only
     * ever granted would leave the interesting half untested — the whole reason
     * to look at the Free view is to see the refusal a Free user gets, and a
     * client gate saying "no" in front of a server that would have said "yes" is
     * a worse test than no simulation at all.
     *
     * Nothing here reaches money. The scope was already re-authorised as an
     * administrator, the credit ledger and every subscription, payment and
     * credit-grant path key on the real account and never pass through this
     * request-scoped gate, and the credits an administrator spends inside a
     * sandbox are their own real credits — which the switch dialog says plainly
     * rather than this class pretending otherwise.
     *
     * @param {object} scope a resolved ViewScopeResolver scope in a plan view
     * @param {number} planFeature a PlanFeatures value
     */
    static async #evaluateForPlanView(scope, planFeature)
    {
        // Same override refresh the personal path performs, so what is simulated
        // is what an administrator has CONFIGURED for that tier rather than what
        // was compiled into PlanMetadataConstants.
        try
        {
            const PlanFeatureConfigurationStore = require("./PlanFeatureConfigurationStore");
            await PlanFeatureConfigurationStore.load();
        }
        catch (configError)
        {
            console.warn(`[PlanEntitlementGate] Feature-config load failed: ${configError?.message || configError}`);
        }

        const simulatedTier = scope.planViewTier;
        const bAllowed = PlanMetadata.hasFeature(simulatedTier, planFeature);

        return {
            allowed: bAllowed,
            // The SIMULATED tier, unlike the organization branch which reports
            // the personal one. There the tier was not what decided the answer;
            // here it is exactly what decided it, and reporting anything else
            // would make the client's refusal describe a different world from the
            // one that produced the refusal.
            currentTier: simulatedTier,
            // The real minimum, unlike the organization branch which reports
            // null. "Upgrade to Pro" is precisely what a real user at this tier
            // would be told, and reproducing that faithfully is the feature.
            requiredTier: PlanEntitlementGate.#minimumTierForFeature(planFeature),
            reason: bAllowed ? "OK" : ErrorCodes.FEATURE_NOT_IN_PLAN,
            organizationId: null,
            planViewTierName: scope.planViewTierName
        };
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
