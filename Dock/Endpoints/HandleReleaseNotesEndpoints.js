const { Packetron, PacketronRequestMethod } = require("@gamiumgamers/packetron");
const { listReleaseNotes } = require("./ReleaseNotes/ListReleaseNotes");
const { ensureLogin } = require("./Plugins/EnsureLogin");


/**
 * Registers the user-facing release-notes endpoints.
 *
 *   GET /ReleaseNotes/List → { notes: [...desc by versionSortKey] }
 *
 * Admin-side CRUD lives under /Admin/ReleaseNotes/* in
 * HandleAdminEndpoints.js. This file only exposes the read surface
 * the application itself consumes — gated by ensureLogin so anonymous
 * clients can't poll the archive.
 *
 * @param {Packetron} server
 */
function handleReleaseNotesEndpoints(server)
{
    server.handle
    ({
        routePath: `/ReleaseNotes/List`,
        handler: listReleaseNotes,
        method: PacketronRequestMethod.GET,
        plugins: [ensureLogin]
    });
}

module.exports = { handleReleaseNotesEndpoints };
