const OrganizationPermissionRuleQueryEngine = require("./OrganizationPermissionRuleQueryEngine");
const OrganizationMemberQueryEngine = require("./OrganizationMemberQueryEngine");
const MemberAudienceMatcher = require("./MemberAudienceMatcher");
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
 *   2. The union of every permission rule the member matches — by tag, and by
 *      conditions over the institute's own columns such as an admission year or
 *      a role. Two rules granting different features are two grants: a member in
 *      both the "final-year" and "scholarship" cohorts gets what each was given.
 *   3. An intersection with the organization's own allow-list of grantable
 *      features. That list is what we sold them, so a rule can never reach past
 *      it however it was written.
 *
 * Storage is the same shape but takes the MAXIMUM rather than a sum: two rules
 * offering 500 MB and 1 GB mean the member is entitled to 1 GB, not 1.5.
 *
 * The organization's OWNER is the one exception to all of that. What they may
 * do in their own view is `Organization.adminAllowedFeatures` — a direct
 * super-admin grant, set when the organization is created and editable
 * afterwards from the same dialog that sets the ceilings. It is added on top of
 * whatever the rules already give them, and it is NOT intersected with
 * `grantableFeatures`: that list bounds what the organization may hand its
 * MEMBERS, and bounding the platform's own grant to the owner by it would mean
 * an owner could silently strip their own capability by editing their allow-list.
 *
 * The owner needs this because they are not necessarily on their own roster.
 * Membership is what the rules key on, nothing adds the owner to it, and before
 * this grant existed an owner who never added themselves as a member ran their
 * institute's library on the Free floor — with their own paid plan bypassed,
 * because inside an organization view the personal tier is not consulted at all.
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
     * @returns {Promise<{ featureValues: number[], storageGrantBytes: number, matchedRuleNames: string[], isOwnerGrant: boolean }>}
     */
    static async resolveForMember(organization, userId, email)
    {
        const freeFloorFeatures = PlanMetadata.getFeatureSet(planTiers.FREE);
        const featureValueSet = new Set(freeFloorFeatures);

        const bIsOwner = OrganizationFeatureResolver.isOwner(organization, userId, email);
        if (bIsOwner)
        {
            for (const featureValue of organization.getAdminAllowedFeatures() || [])
            {
                featureValueSet.add(Number(featureValue));
            }
        }

        const member = await OrganizationMemberQueryEngine.findMemberByUserIdOrEmail(organization.getId(), userId, email);
        if (!member)
        {
            // Not a member: the floor, plus the owner's grant when this is the
            // owner. Reachable both for an owner who never joined their own
            // roster and when a membership is removed while a context is still
            // open on a device.
            return {
                featureValues: Array.from(featureValueSet),
                storageGrantBytes: 0,
                matchedRuleNames: [],
                isOwnerGrant: bIsOwner
            };
        }

        const rules = await OrganizationPermissionRuleQueryEngine.listRulesForOrganization(organization.getId());
        const grantableFeatureSet = new Set(organization.getGrantableFeatures() || []);
        const storageCeiling = Number(organization.getMaxStorageGrantBytesPerMember()) || 0;

        const matchedRuleNames = [];
        let storageGrantBytes = 0;

        for (const rule of rules)
        {
            // Decided by the same matcher credit targeting uses, so "who does
            // this description mean" has one answer across the whole product.
            //
            // Answered in memory against the member already loaded above. This
            // runs on every request into an organization, so asking the database
            // once per rule would put a round trip in front of every action a
            // member takes — and a rule set is allowed fifty rules.
            const bMatches = MemberAudienceMatcher.matchesMember(member,
            {
                tagFilter: rule.getTagFilter(),
                matchMode: rule.getMatchMode(),
                attributeConditions: rule.getAttributeConditions()
            });

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
            matchedRuleNames: matchedRuleNames,
            isOwnerGrant: bIsOwner
        };
    }

    /**
     * Whether this account is the organization's owner.
     *
     * The stored account id is the real test. The email is a fallback for the
     * window where an organization was created before its owner had an account:
     * `adminUserId` is empty until UserRoleReconciliator binds it at their first
     * login, and until then the id comparison alone would answer "not the owner"
     * for the person the organization was created for. Both sides are normalised
     * the same way OrganizationQueryEngine normalises the stored address, so a
     * difference in case or padding never decides ownership.
     *
     * @param {Organization} organization
     * @param {string} userId
     * @param {string} email
     * @returns {boolean}
     */
    static isOwner(organization, userId, email)
    {
        if (!organization)
        {
            return false;
        }

        const storedAdminUserId = organization.getAdminUserId() || "";
        if (storedAdminUserId.length > 0 && storedAdminUserId === userId)
        {
            return true;
        }

        const storedAdminEmail = (organization.getAdminEmail() || "").trim().toLowerCase();
        const callerEmail = (typeof email === "string" ? email : "").trim().toLowerCase();
        return storedAdminEmail.length > 0 && storedAdminEmail === callerEmail;
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
