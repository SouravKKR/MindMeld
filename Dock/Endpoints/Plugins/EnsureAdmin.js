const { PacketronPlugin } = require("@gamiumgamers/packetron");
const { getUser } = require("../Helpers/GetUser");
const { slideSessionExpiry } = require("../Helpers/SlideSessionExpiry");
const { userRoles } = require("../../Globals/Enumerations/UserRoles");
const AdminActionAuditor = require("../../Globals/Classes/Security/AdminActionAuditor");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");

const ensureAdmin = new PacketronPlugin
({
    handler: async (request, response) =>
    {
        const user = await getUser(request);

        // Attach the audit listener before the role check so blocked attempts
        // (401/403) are recorded too — a non-admin probing admin routes is itself
        // a security-relevant event worth a persistent trail.
        await AdminActionAuditor.attach(request, response, userRoles.ADMIN);

        if (!user)
        {
            response.sendStatusCode(httpStatus.UNAUTHORIZED);
            return true;
        }

        if (user.getRole() !== userRoles.ADMIN)
        {
            response.sendStatusCode(httpStatus.FORBIDDEN);
            return true;
        }

        request.user = user;
        await slideSessionExpiry(request, response);
        return false;
    }
});

module.exports = { ensureAdmin };
