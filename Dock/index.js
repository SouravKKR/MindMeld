// Supported CLI flags (forward args from run.ps1 / launch directly via `node Dock/index.js`):
//   --debug     Verbose Logger output
//   --logout    Wipe the sessions collection on boot, forcing every user
//               to re-authenticate. Without this flag, existing sessions
//               persist across server restarts (Mongo TTL governs expiry).
require("dotenv").config();

const { Packetron, PacketronServerFlags } = require("@gamiumgamers/packetron");
const path = require("path");
const { handleAuthenticationEndpoints } = require("./Endpoints/HandleAuthenticationEndpoints");
const { handleAutomaticGenerationEndpoints } = require("./Endpoints/HandleAutomaticGenerationEndpoints");
const TaskManager = require("./Globals/Classes/Task/TaskManager");
const { noCache } = require("./Endpoints/Plugins/NoCache");
const { handleSyncEndpoints } = require("./Endpoints/HandleSyncEndpoints");
const { handleAdminEndpoints } = require("./Endpoints/HandleAdminEndpoints");
const { handleLegalEndpoints } = require("./Endpoints/HandleLegalEndpoints");
const { handlePaidDeckEndpoints } = require("./Endpoints/HandlePaidDeckEndpoints");
const { handleActivityEndpoints } = require("./Endpoints/HandleActivityEndpoints");
const { handleAnalysisEndpoints } = require("./Endpoints/HandleAnalysisEndpoints");
const { handleProfileEndpoints } = require("./Endpoints/HandleProfileEndpoints");
const { handleBrowserLlmEndpoints } = require("./Endpoints/BrowserLlm/HandleBrowserLlmEndpoints");
const { handleAskAiEndpoints } = require("./Endpoints/AskAi/HandleAskAiEndpoints");
const Logger = require("./Globals/Classes/Logger");
const KeyManagementService = require("./Globals/Classes/Security/KeyManagementService");
const KeyRotationScheduler = require("./Globals/Classes/Security/KeyRotationScheduler");
const AuthenticationQueryEngine = require("./Globals/Classes/Database/AuthenticationQueryEngine");


Logger.initialize();
TaskManager.initialize();
KeyManagementService.initialize();
KeyRotationScheduler.start();

if (process.argv.includes("--logout"))
{
    AuthenticationQueryEngine.deleteAllSessions()
        .then((deletedCount) =>
        {
            console.log(`[--logout] Cleared ${deletedCount} session(s). All users will be required to re-authenticate.`);
        })
        .catch((deleteAllSessionsError) =>
        {
            console.error("[--logout] Failed to clear sessions:", deleteAllSessionsError);
        });
}

const server = new Packetron({ port: 3000, flags: PacketronServerFlags.START_IMMEDIATELY, maxThreads: 1 });

server.serve({ directory: path.join(__dirname, "Static"), plugins: [noCache] });

// Offline-AI model files live OUTSIDE Dock/Static/ so they're not wiped
// by CopyStaticFiles. Served at /Assets/<...> — frontend constants
// (BrowserLlmDownloadConstants.ASSETS_BASE_PATH) assume "/Assets/Models".
// noCache is intentionally NOT applied here: model shards are large +
// immutable; aggressive HTTP caching cuts re-download cost for a user
// who clears IDB / Cache API and re-pulls.
server.serve({ directory: path.join(__dirname, "Assets"), pathPrefix: "/Assets" });

server.serveFile({ routePath: "/", filePath: path.join(__dirname, "Static", "index.html"), plugins: [noCache] });

handleAuthenticationEndpoints(server);
handleAutomaticGenerationEndpoints(server);
handleSyncEndpoints(server);
handleAdminEndpoints(server);
handleLegalEndpoints(server);
handlePaidDeckEndpoints(server);
handleActivityEndpoints(server);
handleAnalysisEndpoints(server);
handleProfileEndpoints(server);
handleBrowserLlmEndpoints(server);
handleAskAiEndpoints(server);
