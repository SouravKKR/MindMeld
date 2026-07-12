// Supported CLI flags (via `npm run web` / `npm run production`, or launch directly via `node Dock/index.js`):
//   --debug     Verbose Logger output
//   --logout    Wipe the sessions collection on boot, forcing every user
//               to re-authenticate. Without this flag, existing sessions
//               persist across server restarts (Mongo TTL governs expiry).
const path = require("path");

// Load the environment file relative to THIS file, not the current working
// directory. A bare dotenv.config() reads `<cwd>/.env`, so launching the server
// from anywhere other than the Dock directory (e.g. `node Dock/index.js` from
// the repo root, which CLAUDE.md documents, or the test orchestrator that
// launches with cwd = repo root) would silently load nothing — leaving
// MONGODB_URL and every other secret undefined and turning every
// database-backed route into a 500. Anchoring to __dirname makes the launch
// directory irrelevant.
//
// Which env file we load is selected by environment name, in priority order:
//   1. an explicit --environment=<name> flag
//   2. the MINDMELD_ENVIRONMENT variable (set by the systemd unit on each base
//      node, so Dock AND the Agent subprocesses it spawns agree on the environment)
//   3. legacy --debug  -> local
//   4. otherwise       -> production
// Each name maps to Dock/.<name>.env; "local" also falls back to the historical
// Dock/.env so existing local setups keep working. The Agent service mirrors this
// exact resolution in Globals/Utility/EnvironmentLoader.py, so a launch can never
// load one service against the development database and the other against production.
const fileSystem = require("fs");

function resolveEnvironmentName()
{
    const explicitEnvironmentFlag = process.argv.find(argument => argument.startsWith("--environment="));
    if (explicitEnvironmentFlag)
    {
        return explicitEnvironmentFlag.slice("--environment=".length);
    }
    if (process.env.MINDMELD_ENVIRONMENT)
    {
        return process.env.MINDMELD_ENVIRONMENT;
    }
    if (process.argv.includes("--debug"))
    {
        return "local";
    }
    return "production";
}

const environmentName = resolveEnvironmentName();
const candidateEnvironmentFileNames = environmentName === "local"
    ? [".local.env", ".env"]
    : [`.${environmentName}.env`];

let selectedEnvironmentFilePath = path.join(__dirname, candidateEnvironmentFileNames[0]);
for (const candidateEnvironmentFileName of candidateEnvironmentFileNames)
{
    const candidateEnvironmentFilePath = path.join(__dirname, candidateEnvironmentFileName);
    if (fileSystem.existsSync(candidateEnvironmentFilePath))
    {
        selectedEnvironmentFilePath = candidateEnvironmentFilePath;
        break;
    }
}

require("dotenv").config({ path: selectedEnvironmentFilePath });

const { Packetron, PacketronServerFlags } = require("@gamiumgamers/packetron");
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
const { handleTaskStateEndpoints } = require("./Endpoints/HandleTaskStateEndpoints");
const { handleOrganizationEndpoints } = require("./Endpoints/HandleOrganizationEndpoints");
const { handleWebhookEndpoints } = require("./Endpoints/HandleWebhookEndpoints");
const { handleCreditEndpoints } = require("./Endpoints/HandleCreditEndpoints");
const { handleMaintenanceEndpoints } = require("./Endpoints/HandleMaintenanceEndpoints");
const { handleStreakEndpoints } = require("./Endpoints/HandleStreakEndpoints");
const { handleMetricsEndpoints } = require("./Endpoints/HandleMetricsEndpoints");
const { handleDesktopUpdateEndpoints } = require("./Endpoints/DesktopUpdates/HandleDesktopUpdateEndpoints");
const { handleLogIngestEndpoints } = require("./Endpoints/Logs/HandleLogIngestEndpoints");
const Logger = require("./Globals/Classes/Logger");
const LogIngester = require("./Globals/Classes/Logging/LogIngester");
const LogArchivalScheduler = require("./Globals/Classes/Logging/LogArchivalScheduler");
const KeyManagementService = require("./Globals/Classes/Security/KeyManagementService");
const KeyRotationScheduler = require("./Globals/Classes/Security/KeyRotationScheduler");
const AuthenticationQueryEngine = require("./Globals/Classes/Database/AuthenticationQueryEngine");
const { getSession } = require("./Endpoints/Helpers/GetSession");
const { rateLimitPlugin } = require("./Endpoints/Plugins/EnsureRateLimit");
const { requestLoggingPlugin } = require("./Endpoints/Plugins/RequestLogging");
const { legalAcceptancePlugin } = require("./Endpoints/Plugins/EnsureLegalAcceptance");
const { securityHeadersPlugin } = require("./Endpoints/Plugins/SecurityHeaders");
const RateLimiter = require("./Globals/Classes/Security/RateLimiter");
const ForeignExchangeRatesCache = require("./Globals/Classes/Pricing/ForeignExchangeRatesCache");
const EcbRatesClient = require("./Globals/Classes/Pricing/EcbRatesClient");
const ForeignExchangeRatesRefreshScheduler = require("./Globals/Classes/Pricing/ForeignExchangeRatesRefreshScheduler");
const TaskQueueMode = require("./Globals/Classes/Task/TaskQueueMode");
const LocalWorkerSupervisor = require("./Globals/Classes/Task/LocalWorkerSupervisor");
const BurstAutoscaler = require("./Globals/Classes/Burst/BurstAutoscaler");
const OrphanedGenerationReconciler = require("./Globals/Classes/Task/OrphanedGenerationReconciler");


Logger.initialize();
LogIngester.start().catch((logIngesterStartError) =>
{
    console.error("[LogIngester] Startup failed; logs will buffer in memory until the database is reachable:", logIngesterStartError);
});
// Connect Redis, then sweep any generation whose post-pipeline was orphaned by
// a previous process's restart/redeploy (marker left "pending" with no driver),
// settling each into the resumable state so it stops showing a phantom
// "finalization" node and surfaces Resume on the home banner. Chained off
// initialize() so the Redis client is connected before the sweep scans; never
// blocks boot.
TaskManager.initialize()
    .then(() => OrphanedGenerationReconciler.reconcileOnBoot())
    .catch((reconcileError) =>
    {
        console.error("[OrphanedGenerationReconciler] Boot reconciliation failed:", reconcileError);
    });
KeyManagementService.initialize();
KeyRotationScheduler.start();

// ── Distributed task queue + burst fleet (production only) ──────────────────
// When the server is started WITHOUT --debug and DOCK_USE_TASK_QUEUE is on:
//   • LocalWorkerSupervisor keeps a warm baseline of worker processes on this
//     (strong base) node, so queued tasks are always processed even with zero
//     burst VMs.
//   • BurstAutoscaler polls queue depth and scales cheap burst VMs up to a hard
//     cap, then back down when idle. It first tears down any inherited burst VMs
//     so a restart never starts with stray instances. All polling-based — it can
//     never runaway-spend. In --debug, none of this runs and tasks execute as
//     local subprocesses exactly as before.
if (TaskQueueMode.isQueueEnabled())
{
    LocalWorkerSupervisor.start();

    if (BurstAutoscaler.shouldRun())
    {
        BurstAutoscaler.startup().catch((burstStartupError) =>
        {
            console.error("[BurstAutoscaler] Startup failed; continuing without the burst fleet:", burstStartupError);
        });
    }
}

// Foreign-exchange rates: connect the Redis-backed cache, do one best-effort
// initial fetch (so a fresh boot localizes prices immediately), then refresh
// daily. Any failure is recorded as an admin Alert and never blocks boot.
ForeignExchangeRatesCache.initialize()
    .then(() =>
    {
        EcbRatesClient.fetchAndStoreLatestRates().catch(() => {});
        ForeignExchangeRatesRefreshScheduler.start();
    })
    .catch((foreignExchangeInitializationError) =>
    {
        console.error("[ForeignExchangeRates] Cache initialization failed; currency conversion will degrade gracefully:", foreignExchangeInitializationError);
    });

// Log archival: move logs older than the settable interval to cloud storage.
// Runs on the always-on base node; skipped under local --debug so a developer's
// logs stay hot in MongoDB for inspection rather than being shipped to the bucket.
if (!process.argv.includes("--debug"))
{
    LogArchivalScheduler.start();
}

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

// ── Security response headers ──────────────────────────────────────────────
// A global plugin (highest priority, runs before everything) that stamps CSP,
// X-Frame-Options, X-Content-Type-Options, Referrer-Policy and HSTS on every
// response — endpoints, the SPA shell and static assets alike. The CSP is
// compatibility-first (locks framing/base-uri/object-src while allowing the
// https:/inline/wasm/blob sources AdSense, Razorpay, OAuth and the in-browser
// LLMs require) so no existing functionality is affected. Everything is
// overridable from the environment — see Endpoints/Plugins/SecurityHeaders.js.
server.insertGlobalPlugin(securityHeadersPlugin);

// ── Rate limiting ────────────────────────────────────────────────────────────
// Two complementary dimensions, both excluding static resources:
//   • Per-user — a global plugin (runs before routing) that counts each request
//     against the caller's identity (session user, else IP) and 429s on excess.
//     The same plugin attaches a "finish" listener that logs EVERY 429 the
//     server emits (built-in cap, per-user cap, or handler cooldown) to the
//     rate-limit event log for admin review.
//   • Overall — Packetron's built-in per-endpoint maxRequestsPerSecond. Rather
//     than annotate every server.handle(...) call, we wrap handle() once to
//     inject a default cap on every endpoint that doesn't set its own. Static
//     serve()/serveFile() routes are deliberately left untouched (excluded).
server.insertGlobalPlugin(rateLimitPlugin);

// ── Request/error logging ──────────────────────────────────────────────────
// A global plugin (runs before routing, after the rate limiter so it can reuse
// the identity the limiter resolved) that records every response with status
// >= 400 — with the error code and reason the handler returned — into the
// central log. This is the server-wide capture behind "all error codes are
// recorded with reason when they occur".
server.insertGlobalPlugin(requestLoggingPlugin);

// ── Legal-acceptance gate ──────────────────────────────────────────────────
// A global plugin (runs before routing, just below the rate limiter) that
// blocks every protected endpoint with 403 LEGAL_ACCEPTANCE_REQUIRED while the
// authenticated user still owes acceptance of a current Terms-of-Service /
// Privacy-Policy version. This makes acceptance a SERVER-ENFORCED precondition
// for app access — a non-standard client can no longer skip the consent step.
// The login handshake, /GetUser, /Logout, /LegalDocuments, /Legal/Accept and
// all static assets stay reachable so the user can read and accept.
server.insertGlobalPlugin(legalAcceptancePlugin);

const registerHandler = server.handle.bind(server);
server.handle = (options = {}) =>
{
    if (options.maxRequestsPerSecond === undefined || options.maxRequestsPerSecond === null)
    {
        options.maxRequestsPerSecond = RateLimiter.DEFAULT_OVERALL_MAX_REQUESTS_PER_SECOND;
    }
    return registerHandler(options);
};

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
handleTaskStateEndpoints(server);
handleOrganizationEndpoints(server);
handleWebhookEndpoints(server);
handleCreditEndpoints(server);
handleMaintenanceEndpoints(server);
handleStreakEndpoints(server);
handleMetricsEndpoints(server);
handleDesktopUpdateEndpoints(server);
handleLogIngestEndpoints(server);
