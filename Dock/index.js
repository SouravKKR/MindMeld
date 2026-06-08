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
const { handleReleaseNotesEndpoints } = require("./Endpoints/HandleReleaseNotesEndpoints");
const { handlePaidDeckEndpoints } = require("./Endpoints/HandlePaidDeckEndpoints");
const { handleActivityEndpoints } = require("./Endpoints/HandleActivityEndpoints");
const { handleAnalysisEndpoints } = require("./Endpoints/HandleAnalysisEndpoints");
const { handleProfileEndpoints } = require("./Endpoints/HandleProfileEndpoints");
const { handleBrowserLlmEndpoints } = require("./Endpoints/BrowserLlm/HandleBrowserLlmEndpoints");
const { handleAskAiEndpoints } = require("./Endpoints/AskAi/HandleAskAiEndpoints");
const { handleMockTestEndpoints } = require("./Endpoints/HandleMockTestEndpoints");
const { handleOrganizationEndpoints } = require("./Endpoints/HandleOrganizationEndpoints");
const { handleWebhookEndpoints } = require("./Endpoints/HandleWebhookEndpoints");
const Logger = require("./Globals/Classes/Logger");
const KeyManagementService = require("./Globals/Classes/Security/KeyManagementService");
const KeyRotationScheduler = require("./Globals/Classes/Security/KeyRotationScheduler");
const AuthenticationQueryEngine = require("./Globals/Classes/Database/AuthenticationQueryEngine");
const { getSession } = require("./Endpoints/Helpers/GetSession");
const FxRatesCache = require("./Globals/Classes/Pricing/FxRatesCache");
const EcbRatesClient = require("./Globals/Classes/Pricing/EcbRatesClient");
const FxRatesRefreshScheduler = require("./Globals/Classes/Pricing/FxRatesRefreshScheduler");


Logger.initialize();
TaskManager.initialize();
KeyManagementService.initialize();
KeyRotationScheduler.start();

// Foreign-exchange rates: connect the Redis-backed cache, do one best-effort
// initial fetch (so a fresh boot localizes prices immediately), then refresh
// daily. Any failure is recorded as an admin Alert and never blocks boot.
FxRatesCache.initialize()
    .then(() =>
    {
        EcbRatesClient.fetchAndStoreLatestRates().catch(() => {});
        FxRatesRefreshScheduler.start();
    })
    .catch((fxInitializationError) =>
    {
        console.error("[FxRates] Cache initialization failed; currency conversion will degrade gracefully:", fxInitializationError);
    });

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

// Auth gate at the SPA entry point. An unauthenticated visitor receives
// the standalone login shell (login.html — a few KB of HTML + LoginPage
// modules) instead of the full SPA bundle, so the heavy app code is only
// downloaded once the user has a valid session cookie. After the OAuth
// callback sets the cookie and 302-redirects back to origin, the next
// request through this gate naturally serves index.html and the full SPA
// boots in the authenticated state.
//
// Both "/" and "/index.html" are gated explicitly — the static directory
// serve would otherwise hand out index.html directly to anyone hitting
// the latter URL.
const indexHtmlPath = path.join(__dirname, "Static", "index.html");
const loginHtmlPath = path.join(__dirname, "Static", "login.html");

async function handleSpaEntry(request, response)
{
    let session = null;
    try
    {
        session = await getSession(request);
    }
    catch (sessionLookupError)
    {
        console.error("[SPA gate] Session lookup failed, falling back to login shell:", sessionLookupError);
    }

    response.sendFile(session ? indexHtmlPath : loginHtmlPath);
}

server.handle({ routePath: "/", handler: handleSpaEntry, plugins: [noCache] });
server.handle({ routePath: "/index.html", handler: handleSpaEntry, plugins: [noCache] });

handleAuthenticationEndpoints(server);
handleAutomaticGenerationEndpoints(server);
handleSyncEndpoints(server);
handleAdminEndpoints(server);
handleLegalEndpoints(server);
handleReleaseNotesEndpoints(server);
handlePaidDeckEndpoints(server);
handleActivityEndpoints(server);
handleAnalysisEndpoints(server);
handleProfileEndpoints(server);
handleBrowserLlmEndpoints(server);
handleAskAiEndpoints(server);
handleMockTestEndpoints(server);
handleOrganizationEndpoints(server);
handleWebhookEndpoints(server);
