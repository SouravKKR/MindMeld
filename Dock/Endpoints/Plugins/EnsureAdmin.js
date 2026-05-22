const { PacketronPlugin } = require("@gamiumgamers/packetron");
const { getUser } = require("../Helpers/GetUser");
const { userRoles } = require("../../Globals/Enumerations/UserRoles");

const ensureAdmin = new PacketronPlugin
({
    handler: async (request, response) =>
    {
        const user = await getUser(request);

        if (!user)
        {
            response.sendStatusCode(401);
            return true;
        }

        if (user.getRole() !== userRoles.ADMIN)
        {
            response.sendStatusCode(403);
            return true;
        }

        request.user = user;
        return false;
    }
});

module.exports = { ensureAdmin };
