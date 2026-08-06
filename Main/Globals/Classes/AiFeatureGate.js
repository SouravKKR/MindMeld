import DialogBox from "../../CommonComponents/DialogBox.js";
import UserIdentityManager from "./UserIdentityManager.js";
import OrganizationContextRegistry from "./Organization/OrganizationContextRegistry.js";
import PlanMetadataConstants from "../Constants/PlanMetadataConstants.js";
import { planTiers } from "../Enumerations/PlanTiers.js";
import { planFeatures } from "../Enumerations/PlanFeatures.js";

/**
 * AiFeatureGate
 *
 * Centralised allow-list check for AI features. Every server-cost-incurring
 * AI feature (Generate With AI, the weekly auto-analysis, curated-study
 * generation, etc.) routes through this class so the access policy lives in
 * exactly one place.
 *
 * Two layers:
 *   1. isAllowed() — is there a signed-in user at all.
 *   2. hasFeature(planFeature) — does the signed-in user's plan tier include
 *      the feature (Free / Basic / Pro / Pro Plus), read from the same
 *      PlanMetadataConstants the server uses.
 *
 * Inside an organization view the answer comes from the INSTITUTE instead of
 * the personal plan: what a member may do there is what their organization
 * granted their tags, never what they pay for privately. The two are kept
 * separate on purpose — joining an institute must not silently upgrade or
 * downgrade a private account, in either direction.
 *
 * This gate is UX only: the server re-authorizes every AI call against the
 * stored plan or the organization's rules (PlanEntitlementGate) and returns
 * FEATURE_NOT_IN_PLAN when neither includes it. The client value is never
 * trusted.
 */
class AiFeatureGate
{
    static UNAUTHORIZED_TITLE = "Sign in required";
    static UNAUTHORIZED_MESSAGE = "Please sign in to use AI features.";
    static UPGRADE_TITLE = "Upgrade required";

    // An organization member cannot buy their way past a rule their institute
    // set, so the refusal names who to ask rather than offering an upgrade.
    static ORGANIZATION_RESTRICTED_TITLE = "Not available in this view";

    /**
     * True when there is a signed-in user who may use AI features. Cost is
     * gated separately by the credits system, so this only confirms the
     * user is authenticated.
     */
    static isAllowed()
    {
        const currentUser = window["user"];
        return Boolean(currentUser && typeof currentUser.getRole === "function");
    }

    /**
     * The current user's effective plan tier (with read-time expiry), or FREE
     * when signed out or when the user model predates plan support.
     * @returns {number} planTiers value
     */
    static getCurrentPlanTier()
    {
        // Read the plan from additionalData directly — the User model is
        // codegen-derived and carries no plan getter. Applies read-time expiry
        // so a lapsed plan shows as FREE. UX only; the server re-authorizes.
        const currentUser = window["user"];
        const additionalData = (currentUser && typeof currentUser.getAdditionalData === "function") ? (currentUser.getAdditionalData() || {}) : {};
        const storedTier = Number(additionalData.plan);
        if (!Object.values(planTiers).includes(storedTier) || storedTier === planTiers.FREE)
        {
            return planTiers.FREE;
        }
        const expiresAt = Number(additionalData.planExpiresAt);
        if (!isNaN(expiresAt) && expiresAt < Date.now())
        {
            return planTiers.FREE;
        }
        return storedTier;
    }

    static #tierName(tier)
    {
        for (const tierName of Object.keys(planTiers))
        {
            if (planTiers[tierName] === Number(tier))
            {
                return tierName;
            }
        }
        return "FREE";
    }

    static #featureName(planFeature)
    {
        for (const featureName of Object.keys(planFeatures))
        {
            if (planFeatures[featureName] === Number(planFeature))
            {
                return featureName;
            }
        }
        return null;
    }

    /**
     * True when the current user's plan tier includes the given feature.
     * @param {number} planFeature — PlanFeatures value
     */
    static hasFeature(planFeature)
    {
        const featureName = AiFeatureGate.#featureName(planFeature);
        if (featureName === null)
        {
            return false;
        }

        const organizationContextId = UserIdentityManager.getOrganizationContextId();
        if (organizationContextId.length > 0)
        {
            return OrganizationContextRegistry.isFeatureAllowedInContext(organizationContextId, Number(planFeature));
        }

        const metadata = PlanMetadataConstants[AiFeatureGate.#tierName(AiFeatureGate.getCurrentPlanTier())];
        return Boolean(metadata && Array.isArray(metadata.features) && metadata.features.includes(featureName));
    }

    /**
     * The lowest tier that unlocks the feature, as { tier, label }, for the
     * upgrade prompt — or null when no tier includes it.
     * @param {number} planFeature — PlanFeatures value
     */
    static minimumTierForFeature(planFeature)
    {
        const featureName = AiFeatureGate.#featureName(planFeature);
        if (featureName === null)
        {
            return null;
        }
        for (const tierName of PlanMetadataConstants.ORDER)
        {
            const metadata = PlanMetadataConstants[tierName];
            if (metadata && Array.isArray(metadata.features) && metadata.features.includes(featureName))
            {
                return { tier: planTiers[tierName], label: metadata.label };
            }
        }
        return null;
    }

    /**
     * True when there is a signed-in user AND their plan includes the feature.
     * Use in background dispatchers to silently skip without a dialog.
     * @param {number} planFeature — PlanFeatures value
     */
    static isFeatureAllowed(planFeature)
    {
        return AiFeatureGate.isAllowed() && AiFeatureGate.hasFeature(planFeature);
    }

    /**
     * Presentation for a server-side FEATURE_NOT_IN_PLAN (403) refusal, keyed
     * off the authoritative requiredTier the server returned rather than the
     * client's possibly-stale cached plan. Call this when a fetch to an
     * endpoint gated by PlanEntitlementGate.requireFeature comes back 403, so
     * the user sees an upgrade prompt instead of a generic connection-error
     * message from a catch-all handler further down.
     * @param {{ requiredTier?: number }} detail — parsed 403 response body
     * @param {string} featureLabel — human name for the dialog copy
     */
    static async showFeatureNotInPlanAlert(detail = {}, featureLabel = "This feature")
    {
        // The server reports requiredTier: null inside an organization view,
        // precisely so the client does not send a member down an upgrade path
        // that cannot help them.
        const organizationContextId = UserIdentityManager.getOrganizationContextId();
        if (organizationContextId.length > 0)
        {
            const organizationName = OrganizationContextRegistry.getOrganizationName(organizationContextId);
            await DialogBox.alert(
                AiFeatureGate.ORGANIZATION_RESTRICTED_TITLE,
                `${featureLabel} has not been enabled by ${organizationName} for this view. It may still be available in your own library — switch to viewing as yourself from the profile menu.`
            );
            return;
        }

        const requiredTier = typeof detail.requiredTier === "number" ? detail.requiredTier : null;
        const metadata = requiredTier !== null ? PlanMetadataConstants[AiFeatureGate.#tierName(requiredTier)] : null;
        const upgradeTarget = metadata ? `${metadata.label} plan` : "a higher plan";
        await DialogBox.alert(
            AiFeatureGate.UPGRADE_TITLE,
            `${featureLabel} is available on the ${upgradeTarget}. Upgrade your plan to unlock it.`
        );
    }

    /**
     * Returns true when the current user may use AI features. Otherwise pops
     * a standard dialog and returns false. Use this in user-initiated entry
     * points (button clicks, page loads, toggle changes). Do NOT use it in
     * background dispatchers — those should silently skip via isAllowed() to
     * avoid surprising the user with a dialog they didn't trigger.
     */
    static async ensureAllowedOrShowAlert()
    {
        if (AiFeatureGate.isAllowed())
        {
            return true;
        }

        await DialogBox.alert(AiFeatureGate.UNAUTHORIZED_TITLE, AiFeatureGate.UNAUTHORIZED_MESSAGE);
        return false;
    }

    /**
     * Sign-in check, then plan-feature check. On a locked feature, pops an
     * upgrade dialog naming the lowest tier that unlocks it and returns false.
     * Use in user-initiated entry points for tier-gated features (generation,
     * image generation, mock-test evaluation, curated study).
     * @param {number} planFeature — PlanFeatures value
     * @param {string} featureLabel — human name for the dialog copy
     */
    static async ensureFeatureAllowedOrShowAlert(planFeature, featureLabel = "This feature")
    {
        if (!(await AiFeatureGate.ensureAllowedOrShowAlert()))
        {
            return false;
        }

        if (AiFeatureGate.hasFeature(planFeature))
        {
            return true;
        }

        // Inside an organization view an upgrade prompt would be misleading —
        // buying a plan changes nothing here.
        const organizationContextId = UserIdentityManager.getOrganizationContextId();
        if (organizationContextId.length > 0)
        {
            const organizationName = OrganizationContextRegistry.getOrganizationName(organizationContextId);
            await DialogBox.alert(
                AiFeatureGate.ORGANIZATION_RESTRICTED_TITLE,
                `${featureLabel} has not been enabled by ${organizationName} for this view. It may still be available in your own library — switch to viewing as yourself from the profile menu.`
            );
            return false;
        }

        const minimumTier = AiFeatureGate.minimumTierForFeature(planFeature);
        const upgradeTarget = minimumTier ? `${minimumTier.label} plan` : "a higher plan";
        await DialogBox.alert(
            AiFeatureGate.UPGRADE_TITLE,
            `${featureLabel} is available on the ${upgradeTarget}. Upgrade your plan to unlock it.`
        );
        return false;
    }
}

export default AiFeatureGate;
