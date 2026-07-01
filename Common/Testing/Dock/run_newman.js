// Builds the MindMeld Postman collection (data-driven from the endpoint tables
// below), writes it to MindMeld.postman_collection.json so it is openable in
// Postman, then runs it with Newman against BASE_URL. The collection asserts the
// public/protected boundary required by the test plan:
//
//   * Static + intentionally-public routes are reachable (status < 500).
//   * EVERY protected route rejects an anonymous request with 401 or 403.
//   * A protected route with an INVALID session cookie is still rejected.
//
// Result JSON (uniform schema) is written to $RESULT_FILE or
// Common/Reports/.results/dock-api.json. Coverage = distinct routes exercised
// over the total catalogued endpoints.

const fs = require("fs");
const path = require("path");
const { writeResult, writeSkipped } = require("./_harness");

const REPOSITORY_ROOT = path.resolve(__dirname, "..", "..", "..");
const RESULT_FILE = process.env.RESULT_FILE
    || path.join(REPOSITORY_ROOT, "Common", "Reports", ".results", "dock-api.json");
const COLLECTION_PATH = path.join(__dirname, "MindMeld.postman_collection.json");
const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:3000";
const CATEGORY = "Endpoints + Auth Isolation (Newman)";

// -- Endpoint tables (extend these as the API grows) --------------------------

// Reachable without a session by design. We assert the server responds (no 5xx);
// these are FLAGGED in the report so each non-static public route can be
// reviewed against the "only static files unauthenticated" requirement.
const PUBLIC_ROUTES = [
    { method: "GET", path: "/", expectHtml: true, note: "static SPA shell" },
    { method: "GET", path: "/index.html", expectHtml: true, note: "static SPA shell" },
    { method: "GET", path: "/LegalDocuments", note: "public legal docs" },
    { method: "GET", path: "/PaidDecks/Library", note: "public library browse" },
    { method: "GET", path: "/PaidDecks/Filters", note: "public filter metadata" },
    { method: "POST", path: "/PaidDecks/Search", body: {}, note: "public search" },
    { method: "GET", path: "/GetUser", note: "session probe (200 empty or 401)" },
    { method: "POST", path: "/Auth/RequestOtp", body: {}, note: "pre-auth OTP request (reachable; 400 on empty body)" },
    { method: "POST", path: "/Auth/VerifyOtp", body: {}, note: "pre-auth OTP verify (reachable; 400 on empty body)" },
];

// HMAC-signed, session-less, and side-effecting (payment provider callbacks).
// These are intentionally reachable without a session but are NOT exercised by
// the automated suite — POSTing junk to a live payment webhook is unsafe. They
// are documented in DockTests.txt as the explicit non-static public exception.
//   POST /Webhooks/Razorpay  -> 200 (validates an HMAC signature, not a cookie)
//   POST /Webhooks/Zoho      -> 200 (validates a Zoho payment signature, not a cookie)

// Must reject an anonymous request with 401 or 403 (never 200, never 5xx).
const PROTECTED_ROUTES = [
    { method: "POST", path: "/UpdateUserAdditionalData" },
    { method: "GET", path: "/Auth/Devices" },
    { method: "POST", path: "/Auth/Devices/SignOut" },
    { method: "POST", path: "/Auth/Devices/Register" },
    { method: "POST", path: "/Auth/Heartbeat" },
    { method: "POST", path: "/Sync" },
    { method: "POST", path: "/Sync/Lock" },
    { method: "POST", path: "/Sync/Unlock" },
    { method: "POST", path: "/Sync/ForceUnlock" },
    { method: "GET", path: "/Sync/BulkSnapshot" },
    { method: "POST", path: "/Sync/Licenses" },
    { method: "POST", path: "/Generate" },
    { method: "POST", path: "/Generate/EstimateCost" },
    { method: "GET", path: "/Generate/Progress" },
    { method: "POST", path: "/InformationSource/Upload" },
    { method: "GET", path: "/InformationSource/List" },
    { method: "GET", path: "/InformationSource/Download" },
    { method: "GET", path: "/Templates/Search" },
    { method: "GET", path: "/Templates/Get" },
    { method: "POST", path: "/Decks/BeautifyShortNames" },
    { method: "GET", path: "/Decks/BeautifyShortNames/Result" },
    { method: "POST", path: "/Legal/Accept" },
    { method: "GET", path: "/ReleaseNotes/List" },
    { method: "POST", path: "/PaidDecks/Purchase/Initiate" },
    { method: "POST", path: "/PaidDecks/Purchase/Verify" },
    { method: "GET", path: "/PaidDecks/MyPurchases" },
    { method: "GET", path: "/PaidDecks/Purchases/Invoice" },
    { method: "POST", path: "/PaidDecks/SetPassword" },
    { method: "POST", path: "/PaidDecks/UnlockSession" },
    { method: "GET", path: "/PaidDecks/Manifest" },
    { method: "POST", path: "/PaidDecks/Entities/Fetch" },
    { method: "POST", path: "/PaidDecks/Entities/Update" },
    { method: "POST", path: "/PaidDecks/Copies/Add" },
    { method: "POST", path: "/PaidDecks/Copies/Delete" },
    { method: "POST", path: "/Activity/Search" },
    { method: "GET", path: "/Activity/Tasks/Progress" },
    { method: "GET", path: "/Activity/Tasks/CreditSummary" },
    { method: "POST", path: "/Analysis/QueueDeckAnalysis" },
    { method: "POST", path: "/Profile/ClearUserData" },
    { method: "POST", path: "/MockTest/EvaluateAttempt" },
    { method: "GET", path: "/TaskState" },
    { method: "POST", path: "/TaskState/Discard" },
    { method: "GET", path: "/BrowserLlm/Manifest" },
    { method: "POST", path: "/AskAi/Query/Basic" },
    { method: "POST", path: "/AskAi/Query/Pro" },
    { method: "POST", path: "/AskAi/Query/ProPlus" },
    { method: "GET", path: "/Credits/Purchase/Options" },
    { method: "POST", path: "/Credits/Purchase/Initiate" },
    { method: "POST", path: "/Credits/Purchase/Verify" },
    { method: "GET", path: "/Maintenance/Status" },
    { method: "POST", path: "/PaidDecks/ScreenshotAttempt" },
    { method: "POST", path: "/PaidDecks/ChangePassword" },
    { method: "GET", path: "/Organization/Mine/List" },
    { method: "GET", path: "/Organization/Get" },
    { method: "GET", path: "/Organization/Members/List" },
    { method: "POST", path: "/Organization/Members/Add" },
    { method: "POST", path: "/Organization/Members/Remove" },
    { method: "POST", path: "/Organization/Members/BulkAdd" },
    { method: "POST", path: "/Organization/Members/BulkRemove" },
    { method: "GET", path: "/Admin/ShadowStats" },
    { method: "GET", path: "/Admin/PaidDecks/List" },
    { method: "POST", path: "/Admin/PaidDecks/Upload" },
    { method: "POST", path: "/Admin/PaidDecks/Update" },
    { method: "POST", path: "/Admin/PaidDecks/Pricing" },
    { method: "POST", path: "/Admin/PaidDecks/Bundle" },
    { method: "POST", path: "/Admin/PaidDecks/RotateKey" },
    { method: "POST", path: "/Admin/PaidDecks/RotateContentKey" },
    { method: "POST", path: "/Admin/PaidDecks/BulkUpdate" },
    { method: "GET", path: "/Admin/Stats/Revenue" },
    { method: "POST", path: "/Admin/Users/SetRole" },
    { method: "GET", path: "/Admin/AdminEmails" },
    { method: "POST", path: "/Admin/AdminEmails/Add" },
    { method: "POST", path: "/Admin/AdminEmails/Remove" },
    { method: "GET", path: "/Admin/ReleaseNotes/List" },
    { method: "POST", path: "/Admin/ReleaseNotes/Create" },
    { method: "POST", path: "/Admin/ReleaseNotes/Update" },
    { method: "POST", path: "/Admin/ReleaseNotes/Delete" },
    { method: "GET", path: "/Admin/Maintenance/List" },
    { method: "POST", path: "/Admin/Maintenance/Add" },
    { method: "POST", path: "/Admin/Maintenance/Update" },
    { method: "POST", path: "/Admin/Maintenance/Remove" },
    { method: "POST", path: "/Admin/Organizations/SendAdminVerificationOtp" },
    { method: "POST", path: "/Admin/Organizations/VerifyAdminVerificationOtp" },
    { method: "POST", path: "/Admin/Organizations/Create" },
    { method: "POST", path: "/Admin/Organizations/VerifyCreationPayment" },
    { method: "GET", path: "/Admin/Organizations/List" },
    { method: "GET", path: "/Admin/Organizations/Get" },
    { method: "POST", path: "/Admin/Organizations/UpdatePerks" },
    { method: "POST", path: "/Admin/Organizations/InitiateExpansion" },
    { method: "POST", path: "/Admin/Organizations/VerifyExpansionPayment" },
    { method: "POST", path: "/Admin/Organizations/Delete" },
    { method: "GET", path: "/Admin/RateLimits/List" },
    { method: "GET", path: "/Admin/Audit/List" },
    { method: "GET", path: "/Admin/Alerts/List" },
    { method: "POST", path: "/Admin/Alerts/Acknowledge" },
    { method: "POST", path: "/Admin/Alerts/Delete" },
    { method: "GET", path: "/Admin/Credits/Config" },
    { method: "POST", path: "/Admin/Credits/Config/Save" },
    { method: "POST", path: "/Admin/Credits/Grant/Preview" },
    { method: "POST", path: "/Admin/Credits/Grant/Apply" },
    // Account: hard-delete is login-gated.
    { method: "POST", path: "/Auth/DeleteAccount" },
    // Profile: promo-code redemption (login-gated, credit-granting).
    { method: "POST", path: "/Profile/RedeemPromoCode" },
    // Login-streak + achievement metrics + leaderboard (all ensureLogin).
    { method: "POST", path: "/Streak/AcknowledgeBadges" },
    { method: "POST", path: "/Streak/ReportStudyActivity" },
    { method: "POST", path: "/Metrics/Sync" },
    { method: "POST", path: "/Metrics/AcknowledgeBadges" },
    { method: "GET", path: "/Leaderboard/Me" },
    // Admin: organization rename / capacity (ensureAdmin).
    { method: "POST", path: "/Admin/Organizations/Rename" },
    { method: "POST", path: "/Admin/Organizations/SetMaxMembers" },
    // Admin: paid-deck field generation + per-user streak override (ensureAdmin).
    { method: "POST", path: "/Admin/PaidDecks/GenerateField" },
    { method: "POST", path: "/Admin/Streak/SetUserStreak" },
    // Admin: generic list metadata + query console (ensureAdmin).
    { method: "GET", path: "/Admin/Lists/Metadata" },
    { method: "POST", path: "/Admin/Lists/Query" },
    // Admin: credit deal payments (manual enterprise deals + invoices, ensureAdmin).
    { method: "POST", path: "/Admin/Credits/Deals/Create" },
    { method: "POST", path: "/Admin/Credits/Deals/VerifyPayment" },
    { method: "POST", path: "/Admin/Credits/Deals/UploadInvoice" },
    { method: "GET", path: "/Admin/Credits/Deals/Invoice" },
    { method: "GET", path: "/Admin/Credits/Deals/List" },
    // Admin: periodic (recurring) credit assignments (ensureAdmin).
    { method: "POST", path: "/Admin/Credits/Periodic/Create" },
    { method: "GET", path: "/Admin/Credits/Periodic/List" },
    { method: "POST", path: "/Admin/Credits/Periodic/Terminate" },
    { method: "POST", path: "/Admin/Credits/Periodic/Delete" },
    { method: "GET", path: "/Admin/Credits/Periodic/Report" },
    // Admin: promo-code management (ensureAdmin).
    { method: "POST", path: "/Admin/Credits/Promo/Create" },
    { method: "POST", path: "/Admin/Credits/Promo/CreateBulk" },
    { method: "POST", path: "/Admin/Credits/Promo/SetEnabled" },
    { method: "POST", path: "/Admin/Credits/Promo/Delete" },
];

const TOTAL_ENDPOINTS = PUBLIC_ROUTES.length + PROTECTED_ROUTES.length;

// -- Collection builder -------------------------------------------------------

function makeRequest(name, route, testScriptLines, withInvalidCookie)
{
    const header = [{ key: "Content-Type", value: "application/json" }];
    if (withInvalidCookie)
    {
        header.push({ key: "Cookie", value: "sessionId={{invalidSessionId}}" });
    }
    const request = {
        method: route.method,
        header,
        url: { raw: "{{baseUrl}}" + route.path, host: ["{{baseUrl}}"], path: route.path.replace(/^\//, "").split("/") },
    };
    if (route.method === "POST")
    {
        request.body = { mode: "raw", raw: JSON.stringify(route.body || {}) };
    }
    return {
        name,
        request,
        event: [{
            listen: "test",
            script: { type: "text/javascript", exec: testScriptLines },
        }],
    };
}

function buildCollection()
{
    const publicItems = PUBLIC_ROUTES.map(route => makeRequest(
        `PUBLIC ${route.method} ${route.path}`,
        route,
        [
            "pm.test('responds without server error', function () {",
            "    pm.expect(pm.response.code, 'status ' + pm.response.code).to.be.below(500);",
            "});",
            route.expectHtml
                ? "pm.test('serves HTML shell', function () { pm.expect(pm.response.text()).to.include('<'); });"
                : "// content not asserted (public payload varies)",
        ]));

    const protectedItems = PROTECTED_ROUTES.map(route => makeRequest(
        `PROTECTED ${route.method} ${route.path}`,
        route,
        [
            "pm.test('anonymous request is rejected (401/403)', function () {",
            "    pm.expect([401, 403], 'got ' + pm.response.code).to.include(pm.response.code);",
            "});",
        ]));

    // A representative protected route, this time WITH an invalid session cookie,
    // proving the cookie is validated against the store rather than merely present.
    const invalidCookieItems = ["/Sync", "/Activity/Search", "/Admin/ShadowStats"].map(routePath =>
    {
        const route = PROTECTED_ROUTES.find(candidate => candidate.path === routePath) || { method: "GET", path: routePath };
        return makeRequest(
            `INVALID-COOKIE ${route.method} ${route.path}`,
            route,
            [
                "pm.test('invalid session cookie still rejected (401/403)', function () {",
                "    pm.expect([401, 403], 'got ' + pm.response.code).to.include(pm.response.code);",
                "});",
            ],
            true);
    });

    return {
        info: {
            name: "MindMeld API & Auth Isolation",
            schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
            description: "Generated by Common/Testing/Dock/run_newman.js. Asserts the public/protected boundary.",
        },
        item: [
            { name: "Public (unauthenticated reachable)", item: publicItems },
            { name: "Protected (anonymous rejected)", item: protectedItems },
            { name: "Static-only isolation (invalid cookie)", item: invalidCookieItems },
        ],
    };
}

// -- Run with Newman ----------------------------------------------------------

let newman;
try
{
    newman = require("newman");
}
catch (error)
{
    writeSkipped("Dock", CATEGORY, "newman not installed; run `npm install` in Common/Testing/Dock.", RESULT_FILE);
    process.exit(0);
}

const collection = buildCollection();
fs.writeFileSync(COLLECTION_PATH, JSON.stringify(collection, null, 2), "utf-8");

const environment = {
    name: "MindMeld Local",
    values: [
        { key: "baseUrl", value: BASE_URL, enabled: true },
        { key: "invalidSessionId", value: "0".repeat(64), enabled: true },
    ],
};

newman.run({ collection, environment, reporters: [], timeoutRequest: 15000, insecure: true }, (error, summary) =>
{
    if (error || !summary)
    {
        writeSkipped("Dock", CATEGORY, `Newman could not run (server unreachable at ${BASE_URL}?): ${error && error.message}`, RESULT_FILE);
        process.exit(0);
    }

    const cases = [];
    const exercisedRoutes = new Set();
    const responseTimes = [];
    const slowestRequests = [];
    for (const execution of summary.run.executions)
    {
        const name = execution.item.name;
        exercisedRoutes.add(name.replace(/^\w+(-\w+)?\s+\w+\s+/, ""));

        // Observed HTTP response: status code + round-trip time. Newman attaches
        // these to execution.response; absent only on an outright connection
        // failure (no response object), which we surface below.
        const response = execution.response;
        const httpStatus = response ? response.code : null;
        const responseTimeMs = response ? response.responseTime : null;
        if (typeof responseTimeMs === "number")
        {
            responseTimes.push(responseTimeMs);
            slowestRequests.push({ name, httpStatus, responseTimeMs });
        }
        const timingSuffix = (httpStatus !== null || responseTimeMs !== null)
            ? ` [HTTP ${httpStatus === null ? "-" : httpStatus}, ${responseTimeMs === null ? "-" : responseTimeMs + "ms"}]`
            : "";

        const assertions = execution.assertions || [];
        if (assertions.length === 0)
        {
            cases.push({
                name,
                status: "FAIL",
                detail: `request produced no assertion (likely a connection error)${timingSuffix}`,
                httpStatus,
                responseTimeMs,
            });
            continue;
        }
        for (const assertion of assertions)
        {
            const assertionError = assertion.error ? (assertion.error.message || String(assertion.error)) : "";
            cases.push({
                name: `${name} :: ${assertion.assertion}`,
                status: assertion.error ? "FAIL" : "PASS",
                // Always carry the observed status + timing so the report can show
                // how each route actually responded, not just pass/fail.
                detail: (assertionError ? assertionError + " " : "") + timingSuffix.trim(),
                httpStatus,
                responseTimeMs,
            });
        }
    }

    const passed = cases.filter(testCase => testCase.status === "PASS").length;
    const failed = cases.filter(testCase => testCase.status === "FAIL").length;
    const percent = Math.round(1000 * exercisedRoutes.size / TOTAL_ENDPOINTS) / 10;

    // Aggregate response-time metrics across every exercised route.
    const sortedTimes = responseTimes.slice().sort((first, second) => first - second);
    const percentile = (fraction) => sortedTimes.length
        ? sortedTimes[Math.min(sortedTimes.length - 1, Math.floor(fraction * sortedTimes.length))]
        : null;
    const metrics = sortedTimes.length
        ? {
            label: "Response time (ms)",
            requestCount: sortedTimes.length,
            minMs: sortedTimes[0],
            meanMs: Math.round(sortedTimes.reduce((sum, value) => sum + value, 0) / sortedTimes.length),
            p50Ms: percentile(0.5),
            p95Ms: percentile(0.95),
            maxMs: sortedTimes[sortedTimes.length - 1],
            slowest: slowestRequests
                .sort((first, second) => second.responseTimeMs - first.responseTimeMs)
                .slice(0, 5),
        }
        : null;

    const payload = {
        service: "Dock",
        category: CATEGORY,
        status: failed === 0 ? "PASS" : "FAIL",
        passed,
        failed,
        skipped: 0,
        total: cases.length,
        coverage: {
            kind: "endpoint",
            label: "Endpoints",
            percent,
            covered: exercisedRoutes.size,
            total: TOTAL_ENDPOINTS,
            detail: `${exercisedRoutes.size}/${TOTAL_ENDPOINTS} catalogued routes exercised`,
        },
        metrics,
        cases,
        notes: `Public non-static routes reachable unauthenticated (review each as an intentional exception): ${PUBLIC_ROUTES.filter(route => !route.expectHtml).map(route => route.path).join(", ")}.`,
    };
    writeResult(RESULT_FILE, payload);
    const metricsSuffix = metrics ? `, response time mean ${metrics.meanMs}ms / p95 ${metrics.p95Ms}ms / max ${metrics.maxMs}ms` : "";
    console.log(`Dock ${CATEGORY}: ${passed} passed, ${failed} failed, coverage ${percent}%${metricsSuffix}`);
    process.exit(0);
});
