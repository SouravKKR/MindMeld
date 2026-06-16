// Supported CLI flags (forward args from run.ps1 / launch directly via `node Dock/index.js`):
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
// Which file we load depends on the run mode: with --debug we use the local
// .env (development database); without it we use .production.env (the live
// database). This guarantees a debug launch never talks to the production
// database and a production launch never talks to the development one. The
// Agent service makes the same choice via Globals/Utility/EnvironmentLoader.py.
const environmentFileName = process.argv.includes("--debug") ? ".env" : ".production.env";
require("dotenv").config({ path: path.join(__dirname, environmentFileName) });

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
const Logger = require("./Globals/Classes/Logger");
const KeyManagementService = require("./Globals/Classes/Security/KeyManagementService");
const KeyRotationScheduler = require("./Globals/Classes/Security/KeyRotationScheduler");
const AuthenticationQueryEngine = require("./Globals/Classes/Database/AuthenticationQueryEngine");
const { getSession } = require("./Endpoints/Helpers/GetSession");
const { rateLimitPlugin } = require("./Endpoints/Plugins/EnsureRateLimit");
const { legalAcceptancePlugin } = require("./Endpoints/Plugins/EnsureLegalAcceptance");
const { securityHeadersPlugin } = require("./Endpoints/Plugins/SecurityHeaders");
const RateLimiter = require("./Globals/Classes/Security/RateLimiter");
const ForeignExchangeRatesCache = require("./Globals/Classes/Pricing/ForeignExchangeRatesCache");
const EcbRatesClient = require("./Globals/Classes/Pricing/EcbRatesClient");
const ForeignExchangeRatesRefreshScheduler = require("./Globals/Classes/Pricing/ForeignExchangeRatesRefreshScheduler");
const TaskQueueMode = require("./Globals/Classes/Task/TaskQueueMode");
const LocalWorkerSupervisor = require("./Globals/Classes/Task/LocalWorkerSupervisor");
const BurstAutoscaler = require("./Globals/Classes/Burst/BurstAutoscaler");


Logger.initialize();
TaskManager.initialize();
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
