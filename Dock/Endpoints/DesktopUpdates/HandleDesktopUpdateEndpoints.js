const fileSystem = require("fs");
const path = require("path");

const { Packetron } = require("@gamiumgamers/packetron");
const { noCache } = require("../Plugins/NoCache");

// Serves the desktop binary auto-update artifacts consumed by tauri-plugin-updater in the native
// shell: the update manifest (latest.json) and the signed installer files it points at.
//
//   GET /DesktopUpdates/latest.json          → the update manifest (per-platform url + signature)
//   GET /DesktopUpdates/<installer file>     → the signed installer artifacts
//
// The manifest lists only version + urls + signatures (no secrets), and the updater checks it
// before the user is authenticated, so this surface is intentionally PUBLIC (no login gate). The
// files live OUTSIDE Dock/Static/ so CopyStaticFiles' wipe of the built frontend never removes an
// uploaded release. noCache keeps latest.json from being served stale after a new release.
//
// Populate this directory at release time (see Common/ReadmeFiles/Deployment.md "Desktop & mobile
// app distribution"): upload the `tauri build` installer artifacts and a latest.json here.

const DESKTOP_UPDATES_DIRECTORY = path.join(__dirname, "..", "..", "DesktopUpdates");

/**
 * @param {Packetron} server
 */
function handleDesktopUpdateEndpoints(server)
{
    // Ensure the directory exists so the static serve has something to bind to on a fresh machine
    // that has never had a release uploaded yet (the updater then simply gets 404 = "no update").
    if (fileSystem.existsSync(DESKTOP_UPDATES_DIRECTORY) === false)
    {
        fileSystem.mkdirSync(DESKTOP_UPDATES_DIRECTORY, { recursive: true });
    }

    server.serve({ directory: DESKTOP_UPDATES_DIRECTORY, pathPrefix: "/DesktopUpdates", plugins: [noCache] });
}

module.exports = { handleDesktopUpdateEndpoints };
