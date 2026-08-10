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
//   2. the COGNIUMLEARN_ENVIRONMENT variable (set by the systemd unit on each base
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
    if (process.env.COGNIUMLEARN_ENVIRONMENT)
    {
        return process.env.COGNIUMLEARN_ENVIRONMENT;
    }
    if (process.argv.includes("--debug"))
    {
        return "local";
    }
    return "production";
}

// The directory the per-environment env file is read from. When COGNIUMLEARN_SECRETS_DIRECTORY
// is set — the base node points it at a RAM-backed tmpfs mount so no plaintext secret ever
// lands on persistent disk (keeping snapshots and backups clean) — the rendered Dock env
// file lives at <COGNIUMLEARN_SECRETS_DIRECTORY>/Dock. Otherwise it sits beside this file, as it
// always has for local development.
function resolveDockSecretsDirectory()
{
    if (process.env.COGNIUMLEARN_SECRETS_DIRECTORY)
    {
        return path.join(process.env.COGNIUMLEARN_SECRETS_DIRECTORY, "Dock");
    }
    return __dirname;
}

const environmentName = resolveEnvironmentName();
const dockSecretsDirectory = resolveDockSecretsDirectory();
const candidateEnvironmentFileNames = environmentName === "local"
    ? [".local.env", ".env"]
    : [`.${environmentName}.env`];

let selectedEnvironmentFilePath = path.join(dockSecretsDirectory, candidateEnvironmentFileNames[0]);
for (const candidateEnvironmentFileName of candidateEnvironmentFileNames)
{
    const candidateEnvironmentFilePath = path.join(dockSecretsDirectory, candidateEnvironmentFileName);
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
const { staticCachePolicy } = require("./Endpoints/Plugins/StaticCachePolicy");
const { handleSyncEndpoints } = require("./Endpoints/HandleSyncEndpoints");
const { handleAdminEndpoints } = require("./Endpoints/HandleAdminEndpoints");
const { handleLegalEndpoints } = require("./Endpoints/HandleLegalEndpoints");
const { handleAgeEndpoints } = require("./Endpoints/HandleAgeEndpoints");
const { handleReleaseNotesEndpoints } = require("./Endpoints/HandleReleaseNotesEndpoints");
const { handleNotificationEndpoints } = require("./Endpoints/HandleNotificationEndpoints");
const { handleSupportEndpoints } = require("./Endpoints/HandleSupportEndpoints");
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
const { handleSubscriptionEndpoints } = require("./Endpoints/HandleSubscriptionEndpoints");
const { handleMaintenanceEndpoints } = require("./Endpoints/HandleMaintenanceEndpoints");
const { handleStreakEndpoints } = require("./Endpoints/HandleStreakEndpoints");
const { handleMetricsEndpoints } = require("./Endpoints/HandleMetricsEndpoints");
const { handleDesktopUpdateEndpoints } = require("./Endpoints/DesktopUpdates/HandleDesktopUpdateEndpoints");
const { handleLogIngestEndpoints } = require("./Endpoints/Logs/HandleLogIngestEndpoints");
const { handleSecurityEndpoints } = require("./Endpoints/HandleSecurityEndpoints");
const Logger = require("./Globals/Classes/Logger");
const LogIngester = require("./Globals/Classes/Logging/LogIngester");
const LogArchivalScheduler = require("./Globals/Classes/Logging/LogArchivalScheduler");
const ExpiredInformationSourceReaper = require("./Globals/Classes/Content/ExpiredInformationSourceReaper");
const OverdueComplaintSweeper = require("./Globals/Classes/Legal/OverdueComplaintSweeper");
const KeyManagementService = require("./Globals/Classes/Security/KeyManagementService");
const KeyRotationScheduler = require("./Globals/Classes/Security/KeyRotationScheduler");
const ScriptIntegrityMonitor = require("./Globals/Classes/Security/ScriptIntegrityMonitor");
const ExpiredLicenseSweeper = require("./Globals/Classes/PaidDeck/ExpiredLicenseSweeper");
const OrganizationTermScheduler = require("./Globals/Classes/Organization/OrganizationTermScheduler");
const AuthenticationQueryEngine = require("./Globals/Classes/Database/AuthenticationQueryEngine");
const { getSession } = require("./Endpoints/Helpers/GetSession");
const PaidDeckDeepLinkCookie = require("./Endpoints/Helpers/PaidDeckDeepLinkCookie");
const PaidDeckShareConstants = require("./Globals/Constants/PaidDeckShareConstants");
const { rateLimitPlugin } = require("./Endpoints/Plugins/EnsureRateLimit");
const { requestLoggingPlugin } = require("./Endpoints/Plugins/RequestLogging");
const { legalAcceptancePlugin } = require("./Endpoints/Plugins/EnsureLegalAcceptance");
const { ageConsentPlugin } = require("./Endpoints/Plugins/EnsureAgeConsent");
const { securityHeadersPlugin } = require("./Endpoints/Plugins/SecurityHeaders");
const RateLimiter = require("./Globals/Classes/Security/RateLimiter");
const PaymentEnvironmentValidator = require("./Globals/Classes/Payments/PaymentEnvironmentValidator");
const PaymentAccessPolicy = require("./Globals/Classes/Payments/PaymentAccessPolicy");
const PendingPaymentReconciler = require("./Globals/Classes/Payments/PendingPaymentReconciler");
const FinancialReconciliationService = require("./Globals/Classes/Payments/FinancialReconciliationService");
const ForeignExchangeRatesCache = require("./Globals/Classes/Pricing/ForeignExchangeRatesCache");
const EcbRatesClient = require("./Globals/Classes/Pricing/EcbRatesClient");
const ForeignExchangeRatesRefreshScheduler = require("./Globals/Classes/Pricing/ForeignExchangeRatesRefreshScheduler");
const TaskQueueMode = require("./Globals/Classes/Task/TaskQueueMode");
const LocalWorkerSupervisor = require("./Globals/Classes/Task/LocalWorkerSupervisor");
const BurstAutoscaler = require("./Globals/Classes/Burst/BurstAutoscaler");
const OrphanedGenerationReconciler = require("./Globals/Classes/Task/OrphanedGenerationReconciler");
const SupportTicketDispatchReconciler = require("./Globals/Classes/Support/SupportTicketDispatchReconciler");


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
// Finishes any support-ticket resolution fan-out that a restart interrupted. The
// dispatcher runs in the ephemeral background of the admin's resolve request, so
// without this a redeploy mid-fan-out would leave some reporters credited and
// notified and the rest silently skipped. Safe to replay: credit grants are keyed
// on (ticketId, userId) and only reports with a null notifiedAt are re-read.
SupportTicketDispatchReconciler.startOnBoot();

KeyManagementService.initialize();
KeyRotationScheduler.start();

// Detect that a script allowed to run on a payment page has CHANGED, and tell a
// human [PCI DSS 11.6.1]. Two halves: the served Dock/Static tree is re-hashed
// against the manifest the build wrote (nothing legitimate rewrites it after a
// deploy, so a difference is an incident), and the Razorpay checkout script is
// re-fetched and diffed against its last known bytes (expected to change, but
// it is the one place a compromise of the checkout would surface). Both raise
// admin alerts. The boot check is deliberately delayed so a deploy still
// unpacking is not mistaken for tampering.
ScriptIntegrityMonitor.start();

// Eagerly expire lapsed paid-deck licenses on a schedule (tombstone the seeded
// rows + flip the license to EXPIRED) so cleanup never waits for the affected
// user to sync. Runs one best-effort sweep at boot, then periodically; every
// step is idempotent and it never blocks boot.
ExpiredLicenseSweeper.start();
ExpiredLicenseSweeper.sweep().catch((sweepError) =>
{
    console.error("[ExpiredLicenseSweeper] Boot sweep failed:", sweepError);
});

// Freeze the credit pool of any organization whose contract term has lapsed,
// and warn the ones approaching it. A lapsed term is the one change to an
// organization that happens with nobody acting, so it needs a clock rather than
// a request to notice it. Freezing keeps the credits — they become spendable
// again on renewal — and every step is idempotent, so a boot sweep plus the
// periodic one cannot double-announce anything.
OrganizationTermScheduler.start();

// ── Payment reconciliation ─────────────────────────────────────────────────
// The safety net beneath the browser verify leg and the provider webhook. If
// both fail, a captured payment leaves the buyer charged with nothing granted
// and the pending row is eventually deleted by its TTL, erasing the evidence.
// This sweep asks the provider what really happened and repairs it. Run once at
// boot as well as on a timer, because the outage most likely to have lost a
// webhook is the one that just ended.
PendingPaymentReconciler.start();
PendingPaymentReconciler.sweep().catch((reconcileError) =>
{
    console.error("[PendingPaymentReconciler] Boot sweep failed:", reconcileError);
});
OrganizationTermScheduler.sweep().catch((sweepError) =>
{
    console.error("[OrganizationTermScheduler] Boot sweep failed:", sweepError);
});

// Every other payment guard is per-event and starts from something this server
// already knows about, so none of them can see a payment that exists at the
// provider and matches nothing here. This one starts from Razorpay's own
// account of each closed day and matches it against the money records and the
// ledger, recording a typed report per day and alerting on any break. It also
// holds the slot for the accounting system's figure, which is what makes it a
// reconciliation against accounting records rather than the server agreeing
// with itself.
FinancialReconciliationService.start();
FinancialReconciliationService.sweep().catch((reconcileError) =>
{
    console.error("[FinancialReconciliationService] Boot sweep failed:", reconcileError);
});

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

// Expiry sweep for TEMPORARY-retention uploads. Runs in every mode (including
// --debug) because leaving it off would silently retain documents the user was
// told are temporary — the retention promise must not depend on a launch flag.
ExpiredInformationSourceReaper.start();

// Deadline watch for the public infringement-complaint channel. Runs in every
// mode for the same reason as the reaper above, and more sharply: the 24-hour
// acknowledgment and the 15-day disposal are commitments published in Clause 19
// of the Terms of Service, and a commitment that only holds when the server was
// started without --debug is not a commitment. It notifies; it never disposes
// of a complaint or restores blocked content on its own.
OverdueComplaintSweeper.start();

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

// ── Payment key / environment mode gate ────────────────────────────────────
// Runs before anything is registered. A test key in production captures no
// money while showing customers a success screen; a live key outside
// production charges real cards. Both are silent failures, so the process
// refuses to start rather than serving a broken payment flow.
PaymentEnvironmentValidator.enforceOrExit(environmentName);

// ── Who may spend money here ───────────────────────────────────────────────
// Outside production, payment routes are administrators-only. Configured
// before any route is registered so no request can be served by a payment
// endpoint while the policy is still unset — and the policy itself fails
// closed if that ever happens anyway.
PaymentAccessPolicy.configure(environmentName);
if (!PaymentAccessPolicy.isUnrestrictedEnvironment())
{
    console.warn(`[PaymentAccessPolicy] Environment "${environmentName}": payment features are restricted to administrators.`);
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

// Blocks every protected endpoint with 403 AGE_CONSENT_REQUIRED while an
// authenticated account has no date of birth on file, or is a Child (under 18,
// the definition the Privacy Policy uses) whose parent or guardian has not
// consented. The Policy already promised this; until it was enforced here the
// document described a control that did not exist.
//
// Registered AFTER the legal gate and at a lower priority so terms clear first:
// a user must be able to read the Privacy Policy explaining why a date of birth
// is being collected before being asked to supply one.
server.insertGlobalPlugin(ageConsentPlugin);

const registerHandler = server.handle.bind(server);
server.handle = (options = {}) =>
{
    if (options.maxRequestsPerSecond === undefined || options.maxRequestsPerSecond === null)
    {
        options.maxRequestsPerSecond = RateLimiter.DEFAULT_OVERALL_MAX_REQUESTS_PER_SECOND;
    }
    return registerHandler(options);
};

// no-store for the app's own HTML and bundles (rewritten by every deploy),
// long-lived caching for vendored ThirdParty/ libraries — see StaticCachePolicy
// for why immutability is opted into by versioning the filename.
server.serve({ directory: path.join(__dirname, "Static"), plugins: [staticCachePolicy] });

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

    // A visitor who scanned a paid-deck QR code while signed out is about to be
    // handed the login shell, and the Google leg navigates off-origin — so the
    // deck they asked for is stashed server-side to survive the round trip. A
    // signed-in visitor needs nothing stashed (the SPA reads ?id= off the URL it
    // was served at), so any leftover cookie is cleared instead.
    await PaidDeckDeepLinkCookie.captureOrClear(request, response, session);

    response.sendFile(session ? indexHtmlPath : loginHtmlPath);
}

server.handle({ routePath: "/", handler: handleSpaEntry, plugins: [noCache] });
server.handle({ routePath: "/index.html", handler: handleSpaEntry, plugins: [noCache] });

// The paid-deck share/QR deep link. It is a third door onto the same SPA shell,
// not a page of its own — PaidDeckDeepLinkBootstrap reads ?id= client-side and
// navigates to that deck's store page once the app has booted.
//
// Why a dedicated path rather than "/?id=<deckId>": packetron registers "/"
// under the key path.normalize("") === ".", but dispatching "/?id=x" normalises
// to "?id=x" and only then strips the query, yielding "" — which matches
// nothing, so the bare root 404s the moment a query string is appended. Any
// non-empty path survives that round trip intact ("PaidDeck?id=x" -> "PaidDeck").
// The route table is case-sensitive, so the URL must be exactly this casing.
server.handle({ routePath: PaidDeckShareConstants.DEEP_LINK_ROUTE_PATH, handler: handleSpaEntry, plugins: [noCache] });

// The copyright / IP complaint landing page. Another door onto the same SPA
// shell — CopyrightPageBootstrap (app shell) and LoginPage (sign-in shell) each
// read the path and open the complaint form once booted.
//
// It goes through handleSpaEntry rather than always serving the login shell so
// a signed-in user following the link gets the app they are already in, and a
// signed-out rightsholder gets the sign-in shell, which carries the same public
// form. Neither has to authenticate to file a complaint.
//
// Registered under BOTH casings because the route table is case-sensitive while
// this path is one people copy by hand out of the Terms of Service, out of an
// acknowledgment email, and off a printed page. The lower-case form is the one
// published; the other exists so a capitalised retype is not a 404.
server.handle({ routePath: "/copyright", handler: handleSpaEntry, plugins: [noCache] });
server.handle({ routePath: "/Copyright", handler: handleSpaEntry, plugins: [noCache] });

handleAuthenticationEndpoints(server);
handleAutomaticGenerationEndpoints(server);
handleSyncEndpoints(server);
handleAdminEndpoints(server);
handleLegalEndpoints(server);
handleAgeEndpoints(server);
handleReleaseNotesEndpoints(server);
handleNotificationEndpoints(server);
handleSupportEndpoints(server);
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
handleSubscriptionEndpoints(server);
handleMaintenanceEndpoints(server);
handleStreakEndpoints(server);
handleMetricsEndpoints(server);
handleDesktopUpdateEndpoints(server);
handleLogIngestEndpoints(server);
handleSecurityEndpoints(server);
