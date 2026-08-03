// Preflight for the Puppeteer browser gates (run_tutorial_ui_tests.js and
// run_critical_flow_tests.js). Checks — with hard timeouts, so it always
// terminates — the four things whose absence makes those suites fail in ways
// that look like application bugs but are not:
//
//   1. MongoDB reachable         — without it Dock serves, but nothing loads.
//   2. Redis reachable           — the sync lock lives here; when it is flaky
//                                  the sync engine stalls and its blocking
//                                  modal covers the whole app, holding the
//                                  BlockingOverlayCoordinator slot so tutorials
//                                  cannot even mount.
//   3. Dock serving the CURRENT build — Dock indexes Dock/Static ONCE at boot,
//                                  so a server started before `npm run setup`
//                                  404s every content-hashed bundle chunk and
//                                  the app never boots.
//   4. The session cookie reaches the authenticated shell — otherwise the
//                                  suites SKIP, which fails the deploy gate.
//
//   node Common/Testing/Main/check_browser_gate_environment.js
//
// Env: BASE_URL (default http://127.0.0.1:3000), TEST_SESSION_COOKIE (optional;
//      check 4 is reported as not-run without it), MONGODB_URL / REDIS_URL
//      override Dock/.env.
// Exits non-zero if any check fails.

const fs = require("fs");
const path = require("path");

const REPOSITORY_ROOT = path.resolve(__dirname, "..", "..", "..");
const DOCK_DIRECTORY = path.join(REPOSITORY_ROOT, "Dock");
const STATIC_DIRECTORY = path.join(DOCK_DIRECTORY, "Static");

require(path.join(DOCK_DIRECTORY, "node_modules", "dotenv")).config({ path: path.join(DOCK_DIRECTORY, ".env") });

const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:3000";
const SESSION_COOKIE = process.env.TEST_SESSION_COOKIE || "";
const CHECK_TIMEOUT_MILLISECONDS = 8000;

// A datastore that answers, but slowly, is worse than one that is down: Dock
// serves, the app boots, and then the sync engine's cycles run long enough that
// its blocking "Restoring sync state" modal goes up and never clears — holding
// the BlockingOverlayCoordinator slot, so tutorials cannot even mount. Observed
// on this repo: the suites pass with a ~50ms Mongo ping and fail wholesale at
// ~1400ms (Mongo reached over a WSL tunnel). Treat sluggish as broken.
const DATASTORE_LATENCY_BUDGET_MILLISECONDS = 250;

// Every check is wrapped so a hung socket can never hang the preflight — the
// hang is itself the diagnosis we want to report.
function withTimeout(promise, label)
{
    return Promise.race([
        promise,
        new Promise((resolve) => setTimeout(
            () => resolve({ ok: false, detail: `timed out after ${CHECK_TIMEOUT_MILLISECONDS}ms (nothing answered)` }),
            CHECK_TIMEOUT_MILLISECONDS))
    ]).catch(error => ({ ok: false, detail: error.message }));
}

function describeLatency(storeName, latencyMilliseconds)
{
    if (latencyMilliseconds > DATASTORE_LATENCY_BUDGET_MILLISECONDS)
    {
        return {
            ok: false,
            detail: `ping took ${latencyMilliseconds}ms (budget ${DATASTORE_LATENCY_BUDGET_MILLISECONDS}ms). `
                + `${storeName} answers but is too slow: the sync engine will stall and its blocking modal `
                + "will cover the app, so the browser suites cannot run. Give Dock a local/low-latency "
                + `${storeName} rather than one reached over a tunnel or a remote link.`
        };
    }
    return { ok: true, detail: `ping in ${latencyMilliseconds}ms` };
}

async function checkMongo()
{
    const { MongoClient } = require(path.join(DOCK_DIRECTORY, "node_modules", "mongodb"));
    const url = process.env.MONGODB_URL;

    if (!url)
    {
        return { ok: false, detail: "MONGODB_URL is not set (Dock/.env missing?)" };
    }

    const client = new MongoClient(url, { serverSelectionTimeoutMS: CHECK_TIMEOUT_MILLISECONDS - 1000 });
    const startedAt = Date.now();
    try
    {
        await client.connect();
        await client.db(process.env.MONGODB_DATABASE_NAME).command({ ping: 1 });
        return describeLatency("MongoDB", Date.now() - startedAt);
    }
    finally
    {
        await client.close().catch(() => {});
    }
}

async function checkRedis()
{
    const { createClient } = require(path.join(DOCK_DIRECTORY, "node_modules", "redis"));
    // TaskManager calls createClient() with no arguments, so the client reads
    // REDIS_URL from the environment exactly as the server does.
    const client = createClient();
    client.on("error", () => {});

    const startedAt = Date.now();
    try
    {
        await client.connect();
        await client.ping();
        return describeLatency("Redis", Date.now() - startedAt);
    }
    finally
    {
        await client.quit().catch(() => {});
    }
}

async function fetchStatus(url, headers = {})
{
    const response = await fetch(url, { headers, redirect: "manual" });
    const body = await response.text().catch(() => "");
    return { status: response.status, body };
}

// Dock must serve a chunk that only exists in the CURRENT build. Picking the
// filename off disk means this fails precisely when the running server predates
// the last `npm run setup`.
async function checkDockServesCurrentBuild()
{
    const chunkFileName = fs.readdirSync(STATIC_DIRECTORY)
        .find(fileName => /^Bundle\.(part|chunk)-.*\.js$/.test(fileName));

    if (!chunkFileName)
    {
        return { ok: false, detail: "no Bundle.part-*/chunk-* file in Dock/Static — run `npm run setup` first" };
    }

    const { status } = await fetchStatus(`${BASE_URL}/${chunkFileName}`);

    if (status === 200)
    {
        return { ok: true, detail: `serving ${chunkFileName}` };
    }

    return {
        ok: false,
        detail: `${chunkFileName} -> HTTP ${status}. Dock indexes Dock/Static at boot — RESTART Dock after `
            + "`npm run setup`, and make sure the old `node index.js` child is really dead (it keeps port 3000)."
    };
}

// The account may reach the authenticated shell and STILL be blocked: if any
// legal document's current version is newer than the version the account
// accepted, the terms dialog renders over the app. It sits in the popup layer,
// so a tutorial step's spotlight still lands on the right coordinates while the
// click is intercepted — reported as "step did not advance (target click had no
// effect?)", which reads as a UI bug and is not one. Seeding against a database
// Dock had not booted against yet is the usual cause.
async function checkLegalAcceptanceIsCurrent()
{
    const { MongoClient } = require(path.join(DOCK_DIRECTORY, "node_modules", "mongodb"));
    const LegalAcceptanceService = require(path.join(DOCK_DIRECTORY, "Globals", "Classes", "Authentication", "LegalAcceptanceService"));

    const testAccountId = process.env.TEST_ACCOUNT_ID || "browser-suite-test-user";
    const client = new MongoClient(process.env.MONGODB_URL, { serverSelectionTimeoutMS: CHECK_TIMEOUT_MILLISECONDS - 1000 });

    try
    {
        await client.connect();
        const database = client.db(process.env.MONGODB_DATABASE_NAME);
        const legalDocuments = await database.collection("legalDocuments").find({}).toArray();

        if (legalDocuments.length === 0)
        {
            // The server's own gate fails open with no documents seeded, so this
            // cannot block the suites — but it means Dock has never booted here.
            return { ok: null, detail: "no legal documents seeded — Dock has not booted against this database" };
        }

        const testAccount = await database.collection("users").findOne({ id: testAccountId });
        if (!testAccount)
        {
            return { ok: false, detail: `no "${testAccountId}" account — run seed_browser_test_account.js` };
        }

        const additionalData = testAccount.additionalData || {};
        const outstandingDocuments = legalDocuments.filter(legalDocument =>
            Number(additionalData[LegalAcceptanceService.buildAgreedVersionKey(legalDocument.key)] || 0) < Number(legalDocument.version));

        if (outstandingDocuments.length > 0)
        {
            const outstandingSummary = outstandingDocuments
                .map(legalDocument => `${legalDocument.key} v${legalDocument.version} (accepted v${Number(additionalData[LegalAcceptanceService.buildAgreedVersionKey(legalDocument.key)] || 0)})`)
                .join(", ");

            return { ok: false, detail: `terms dialog WILL block the app — ${outstandingSummary}. Re-run seed_browser_test_account.js` };
        }

        return { ok: true, detail: `all ${legalDocuments.length} document(s) accepted at their current version` };
    }
    finally
    {
        await client.close().catch(() => {});
    }
}

async function checkSessionReachesApp()
{
    if (!SESSION_COOKIE)
    {
        return { ok: null, detail: "TEST_SESSION_COOKIE not set — not checked (the suites would SKIP)" };
    }

    const { status, body } = await fetchStatus(`${BASE_URL}/index.html`, { Cookie: `sessionId=${SESSION_COOKIE}` });

    if (status !== 200)
    {
        return { ok: false, detail: `/index.html -> HTTP ${status}` };
    }

    // The unauthenticated gate serves the much smaller login shell instead.
    if (/LoginBundle|login\.js/.test(body))
    {
        return { ok: false, detail: "served the LOGIN shell — the session is invalid or expired. Re-run seed_browser_test_account.js" };
    }

    return { ok: true, detail: `authenticated shell served (${body.length} bytes)` };
}

(async () =>
{
    const checks = [
        ["MongoDB reachable",              await withTimeout(checkMongo(), "mongo")],
        ["Redis reachable",                await withTimeout(checkRedis(), "redis")],
        ["Dock serves the current build",  await withTimeout(checkDockServesCurrentBuild(), "dock")],
        ["Session reaches the app shell",  await withTimeout(checkSessionReachesApp(), "session")],
        ["Legal acceptance is current",    await withTimeout(checkLegalAcceptanceIsCurrent(), "legal")],
    ];

    let failureCount = 0;

    for (const [label, result] of checks)
    {
        const marker = result.ok === true ? "PASS" : (result.ok === null ? "----" : "FAIL");
        if (result.ok === false)
        {
            failureCount += 1;
        }
        console.log(`[${marker}] ${label.padEnd(32)} ${result.detail}`);
    }

    if (failureCount > 0)
    {
        console.log("");
        console.log(`${failureCount} check(s) failed — fix these before reading the browser suites' results;`);
        console.log("they produce failures that look like application bugs but are not.");
        process.exit(1);
    }

    console.log("");
    console.log("Environment is ready for the browser gates.");
})().catch(error =>
{
    console.error("Preflight crashed:", error.message);
    process.exit(1);
});
