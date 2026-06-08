const AdminEmailQueryEngine = require("../Database/AdminEmailQueryEngine");
const AuthenticationQueryEngine = require("../Database/AuthenticationQueryEngine");
const OrganizationQueryEngine = require("../Organization/OrganizationQueryEngine");
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

        // No elevated claim — demote any stale ADMIN / ORG_ADMIN.
        if (user.getRole() === userRoles.ADMIN || user.getRole() === userRoles.ORG_ADMIN)
        {
            user.setRole(userRoles.USER);
        }
    }

    /**
     * Called from the org-delete handler. If the supplied user no
     * longer admins any ACTIVE org AND isn't in the super-admin
     * allowlist, demote them to USER on the spot — don't wait for
     * their next login.
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

        if (user.getRole() === userRoles.ORG_ADMIN || user.getRole() === userRoles.ADMIN)
        {
            user.setRole(userRoles.USER);
            await AuthenticationQueryEngine.createUser(user);
        }
    }
}

module.exports = UserRoleReconciliator;
