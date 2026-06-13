const { Packetron, PacketronRequestMethod } = require("@gamiumgamers/packetron");
const { getMaintenanceStatus } = require("./Maintenance/GetMaintenanceStatus");
const { ensureLogin } = require("./Plugins/EnsureLogin");

/**
 * Registers the user-facing maintenance endpoint.
 *
 *   GET /Maintenance/Status → { active: window|null, upcoming: [windows] }
 *
 * Admin-side CRUD lives under /Admin/Maintenance/* in HandleAdminEndpoints.js.
 * This read surface is gated by ensureLogin so the SPA can poll for the banner.
 *
 * @param {Packetron} server
 */
function handleMaintenanceEndpoints(server)
{
    server.handle
    ({
        routePath: `/Maintenance/Status`,
        handler: getMaintenanceStatus,
        method: PacketronRequestMethod.GET,
        plugins: [ensureLogin]
    });
}

module.exports = { handleMaintenanceEndpoints };
