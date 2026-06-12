const { PacketronPlugin } = require("@gamiumgamers/packetron");
const { getUser } = require("../Helpers/GetUser");
const { slideSessionExpiry } = require("../Helpers/SlideSessionExpiry");
const { userRoles } = require("../../Globals/Enumerations/UserRoles");
const AdminActionAuditor = require("../../Globals/Classes/Security/AdminActionAuditor");

/**
 * Permits requests from users whose role is either ORG_ADMIN or ADMIN
 * (super-admin acts as a superset of every org-admin's permissions).
 * Per-org ownership ("does this user admin THIS particular org?") is
 * checked inside each handler against the organizationId in the body
 * / query — the plugin only enforces the role floor.
 */
const ensureOrgAdmin = new PacketronPlugin
({
    handler: async (request, response) =>
    {
        const user = await getUser(request);

        // Org-admin member-management is a privileged action on user data; record
        // it in the same audit trail (including blocked attempts) as super-admin.
        await AdminActionAuditor.attach(request, response, userRoles.ORG_ADMIN);

        if (!user)
        {
            response.sendStatusCode(401);
            return true;
        }

        if (user.getRole() !== userRoles.ORG_ADMIN && user.getRole() !== userRoles.ADMIN)
        {
            response.sendStatusCode(403);
            return true;
        }

        request.user = user;
        await slideSessionExpiry(request, response);
        return false;
    }
});

module.exports = { ensureOrgAdmin };
