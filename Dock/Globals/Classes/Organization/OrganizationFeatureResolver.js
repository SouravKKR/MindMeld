const OrganizationPermissionRuleQueryEngine = require("./OrganizationPermissionRuleQueryEngine");
const OrganizationMemberQueryEngine = require("./OrganizationMemberQueryEngine");
const CreditGrantTargetResolver = require("../Credits/CreditGrantTargetResolver");
const PlanMetadata = require("../Plans/PlanMetadata");
const { planTiers } = require("../../Enumerations/PlanTiers");


/**
 * OrganizationFeatureResolver
 *
 * What a member may do, and how much storage they have, INSIDE an
 * organization's view.
 *
 * The result is built from three things, in this order:
 *
 *   1. The Free tier's feature set, as an unremovable floor. An organization
 *      configures what it ADDS; it can never take away what the platform gives
 *      every account, or joining an institute would make a user's own app worse.
 *   2. The union of every permission rule whose tags the member matches. Two
 *      rules granting different features are two grants — a member in both the
 *      "final-year" and "scholarship" cohorts gets what each was given.
 *   3. An intersection with the organization's own allow-list of grantable
 *      features. That list is what we sold them, so a rule can never reach past
 *      it however it was written.
 *
 * Storage is the same shape but takes the MAXIMUM rather than a sum: two rules
 * offering 500 MB and 1 GB mean the member is entitled to 1 GB, not 1.5.
 *
 * This decides the ORG VIEW only. A member's personal plan is untouched, which
 * is the whole point of the separation — an institute grants capability inside
 * its own world without upgrading anybody's private account.
 */
class OrganizationFeatureResolver
{
    /**
     * Resolves one member's entitlements in one organization.
     *
     * @param {Organization} organization
     * @param {string} userId
     * @param {string} email
     * @returns {Promise<{ featureValues: number[], storageGrantBytes: number, matchedRuleNames: string[] }>}
     */
    static async resolveForMember(organization, userId, email)
    {
        const freeFloorFeatures = PlanMetadata.getFeatureSet(planTiers.FREE);

        const member = await OrganizationMemberQueryEngine.findMemberByUserIdOrEmail(organization.getId(), userId, email);
        if (!member)
        {
            // Not a member: the floor only. This is reachable when a membership
            // is removed while a context is still open on a device.
            return { featureValues: freeFloorFeatures.slice(), storageGrantBytes: 0, matchedRuleNames: [] };
        }

        const rules = await OrganizationPermissionRuleQueryEngine.listRulesForOrganization(organization.getId());
        const grantableFeatureSet = new Set(organization.getGrantableFeatures() || []);
        const storageCeiling = Number(organization.getMaxStorageGrantBytesPerMember()) || 0;

        const featureValueSet = new Set(freeFloorFeatures);
        const matchedRuleNames = [];
        let storageGrantBytes = 0;

        for (const rule of rules)
        {
            // Decided by the same predicate credit targeting uses, so "who does
            // this tag mean" has one answer across the whole product.
            const bMatches = CreditGrantTargetResolver.filterMembersByTags([member], rule.getTagFilter(), rule.getMatchMode()).length === 1;
            if (!bMatches)
            {
                continue;
            }

            matchedRuleNames.push(rule.getName());

            for (const featureValue of rule.getAllowedFeatures())
            {
                if (grantableFeatureSet.has(featureValue))
                {
                    featureValueSet.add(featureValue);
                }
            }

            storageGrantBytes = Math.max(storageGrantBytes, Number(rule.getStorageGrantBytes()) || 0);
        }

        if (storageCeiling > 0)
        {
            storageGrantBytes = Math.min(storageGrantBytes, storageCeiling);
        }
        else
        {
            // No ceiling configured means the organization was never sold the
            // right to grant storage at all — not that it may grant unlimited.
            storageGrantBytes = 0;
        }

        return {
            featureValues: Array.from(featureValueSet),
            storageGrantBytes: storageGrantBytes,
            matchedRuleNames: matchedRuleNames
        };
    }

    /**
     * The storage every organization this account belongs to grants it, summed.
     * Used to raise the personal storage cap: a member of two institutes that
     * each provide space has both, because both are providing content that has
     * to fit somewhere.
     *
     * @param {Array<Organization>} organizations
     * @param {string} userId
     * @param {string} email
     * @returns {Promise<number>} extra bytes on top of the personal plan
     */
    static async resolveTotalStorageGrantBytes(organizations, userId, email)
    {
        let totalGrantBytes = 0;

        for (const organization of organizations)
        {
            const entitlement = await OrganizationFeatureResolver.resolveForMember(organization, userId, email);
            totalGrantBytes = totalGrantBytes + entitlement.storageGrantBytes;
        }

        return totalGrantBytes;
    }
}

module.exports = OrganizationFeatureResolver;
