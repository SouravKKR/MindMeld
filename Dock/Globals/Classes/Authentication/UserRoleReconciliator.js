const AdminEmailQueryEngine = require("../Database/AdminEmailQueryEngine");
const AuthenticationQueryEngine = require("../Database/AuthenticationQueryEngine");
const OrganizationQueryEngine = require("../Organization/OrganizationQueryEngine");
const OrganizationMemberQueryEngine = require("../Organization/OrganizationMemberQueryEngine");
const { userRoles } = require("../../Enumerations/UserRoles");


/**
 * UserRoleReconciliator
 *
 * Centralises the role-resolution logic that runs on every login.
 * Precedence: ADMIN > ORG_ADMIN > USER. Replaces the inline allowlist
 * check that used to live in HandleLoginCallback.js, and fills the gap
 * in HandleVerifyOtp.js which previously never reconciled at all (so
 * email-OTP-logging-in admins were silently stuck at USER).
 *
 * ORG_ADMIN covers two different people: the owner of an organization, and a
 * member the owner delegated powers to. The role is only a floor that lets them
 * reach the organization surfaces — what either may actually do is decided
 * per-request by OrganizationAuthorityResolver against stored state.
 *
 * The reconciliator MUTATES the supplied User but does NOT persist it
 * — the caller writes via AuthenticationQueryEngine.createUser as part
 * of its existing flow.
 */
class UserRoleReconciliator
{
    /**
     * Mutates `user.role` to reflect the current state of the
     * admin-email allowlist + organizations.adminEmail. Also back-fills
     * adminUserId on any ACTIVE org this user admins that hasn't yet
     * recorded the userId.
     *
     * @param {User} user — must have additionalData.email populated
     */
    static async reconcile(user)
    {
        const email = (user.getAdditionalData()?.email || "").toLowerCase();
        if (email.length === 0)
        {
            return;
        }

        const isSuperAdmin = await AdminEmailQueryEngine.isAdminEmail(email);
        if (isSuperAdmin)
        {
            if (user.getRole() !== userRoles.ADMIN)
            {
                user.setRole(userRoles.ADMIN);
            }
            return;
        }

        const adminedOrgs = await OrganizationQueryEngine.listActiveOrganizationsByAdminEmail(email);
        if (adminedOrgs.length > 0)
        {
            if (user.getRole() !== userRoles.ORG_ADMIN)
            {
                user.setRole(userRoles.ORG_ADMIN);
            }
            for (const organization of adminedOrgs)
            {
                if (!organization.getAdminUserId() || organization.getAdminUserId().length === 0)
                {
                    await OrganizationQueryEngine.setAdminUserId(organization.getId(), user.getId());
                }
            }
            return;
        }

        // A delegate is an ordinary member the owner handed specific powers to.
        // They need the ORG_ADMIN role floor to reach the organization surfaces
        // at all; which of those surfaces they may actually use is decided
        // per-request by OrganizationAuthorityResolver against their stored
        // power flags, so the role alone grants nothing.
        const bHoldsDelegatePowers = await UserRoleReconciliator.#holdsDelegatePowers(email);
        if (bHoldsDelegatePowers)
        {
            if (user.getRole() !== userRoles.ORG_ADMIN)
            {
                user.setRole(userRoles.ORG_ADMIN);
            }
            return;
        }

        // No elevated claim — demote any stale ADMIN / ORG_ADMIN.
        if (user.getRole() === userRoles.ADMIN || user.getRole() === userRoles.ORG_ADMIN)
        {
            user.setRole(userRoles.USER);
        }
    }

    /**
     * True when this email holds any delegate power in any ACTIVE organization.
     * @param {string} email already lowercased
     * @returns {Promise<boolean>}
     */
    static async #holdsDelegatePowers(email)
    {
        const memberships = await OrganizationMemberQueryEngine.findActiveMembershipsByEmail(email);
        return memberships.some(membership => Number.isInteger(membership.delegatePowers) && membership.delegatePowers > 0);
    }

    /**
     * Called from the org-delete handler. If the supplied user no
     * longer admins any ACTIVE org, holds no delegate powers, AND isn't
     * in the super-admin allowlist, demote them to USER on the spot —
     * don't wait for their next login.
     */
    static async revokeOrgAdminIfNoActiveOrgs(userId)
    {
        if (typeof userId !== "string" || userId.length === 0)
        {
            return;
        }

        const user = await AuthenticationQueryEngine.getUserById(userId);
        if (!user)
        {
            return;
        }

        const email = (user.getAdditionalData()?.email || "").toLowerCase();
        if (email.length > 0)
        {
            const isSuperAdmin = await AdminEmailQueryEngine.isAdminEmail(email);
            if (isSuperAdmin)
            {
                // Super-admin takes precedence — leave the ADMIN role alone.
                return;
            }
        }

        const remainingOrgs = await OrganizationQueryEngine.listActiveOrganizationsByAdminUserId(userId);
        if (remainingOrgs.length > 0)
        {
            // Still admins something — leave the role alone.
            return;
        }

        if (email.length > 0 && await UserRoleReconciliator.#holdsDelegatePowers(email))
        {
            // Still a delegate somewhere else — leave the role alone.
            return;
        }

        if (user.getRole() === userRoles.ORG_ADMIN || user.getRole() === userRoles.ADMIN)
        {
            user.setRole(userRoles.USER);
            await AuthenticationQueryEngine.createUser(user);
        }
    }
}

module.exports = UserRoleReconciliator;
