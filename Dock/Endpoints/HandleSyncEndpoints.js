const { Packetron, PacketronHandlerFlags, PacketronRequestMethod } = require("@gamiumgamers/packetron");
const { handleSync } = require("./Sync/Sync");
const { handleLockSync } = require("./Sync/LockSync");
const { handleUnlockSync } = require("./Sync/UnlockSync");
const { handleForceUnlockSync } = require("./Sync/ForceUnlockSync");
const { handleBulkSnapshot } = require("./Sync/BulkSnapshot");
const { pullLicenses } = require("./Sync/PullLicenses");
const { ensureLogin } = require("./Plugins/EnsureLogin");

/**
 * Registers sync-related endpoints on the server.
 *
 * Endpoints:
 *   POST /Sync        — Main sync handler (push changes, pull changes).
 *   POST /Sync/Lock   — Acquires a per-user sync lock for the requesting device.
 *   POST /Sync/Unlock — Releases the per-user sync lock.
 *
 * All endpoints require authentication via the ensureLogin plugin.
 *
 * @param {Packetron} server - The Packetron server instance.
 */
function handleSyncEndpoints(server)
{
    server.handle(
    {
        routePath: `/Sync`,
        handler: handleSync,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureLogin]
    });

    server.handle(
    {
        routePath: `/Sync/Lock`,
        handler: handleLockSync,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureLogin]
    });

    server.handle(
    {
        routePath: `/Sync/Unlock`,
        handler: handleUnlockSync,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureLogin]
    });

    server.handle(
    {
        routePath: `/Sync/ForceUnlock`,
        handler: handleForceUnlockSync,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureLogin]
    });

    server.handle(
    {
        routePath: `/Sync/BulkSnapshot`,
        handler: handleBulkSnapshot,
        method: PacketronRequestMethod.GET,
        plugins: [ensureLogin]
    });

    server.handle(
    {
        routePath: `/Sync/Licenses`,
        handler: pullLicenses,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureLogin]
    });
}

module.exports = { handleSyncEndpoints };