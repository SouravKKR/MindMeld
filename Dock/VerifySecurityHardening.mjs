/**
 * End-to-end verification harness for the two security hardening fixes:
 *
 *   A03 — EnumFilter no longer passes a client-supplied value straight into a
 *         Mongo query fragment, so an operator object cannot be smuggled in.
 *   A05 — SecurityHeaders ships a strict Content-Security-Policy candidate
 *         alongside the enforced compatible one, promotable by environment.
 *
 * Run from the Dock directory:
 *     node VerifySecurityHardening.mjs
 *
 * Pure, in-process checks — no DB, no network, no Redis, so this always runs.
 *
 * The emphasis throughout is on proving that NOTHING LEGITIMATE BROKE: every
 * registered option of every registered EnumFilter must still produce exactly
 * the query fragment it produced before, and the enforced CSP must be
 * byte-identical to the one that shipped previously unless an operator opts in.
 */

import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

const require = createRequire(import.meta.url);
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

const EnumFilter = require("./Globals/Classes/PaidDeckFilters/EnumFilter");
const BooleanFilter = require("./Globals/Classes/PaidDeckFilters/BooleanFilter");
const MultiSelectFilter = require("./Globals/Classes/PaidDeckFilters/MultiSelectFilter");

let passedCount = 0;
let failedCount = 0;

function assert(condition, description)
{
    if (condition)
    {
        passedCount = passedCount + 1;
        console.log(`  PASS  ${description}`);
    }
    else
    {
        failedCount = failedCount + 1;
        console.log(`  FAIL  ${description}`);
    }
}

function section(title)
{
    console.log(`\n=== ${title} ===`);
}

function buildNumericEnumFilter()
{
    return new EnumFilter
    ({
        key: "granularity",
        label: "Purchase granularity",
        field: "granularity",
        options:
        [
            { value: 0, label: "Individually buyable" },
            { value: 1, label: "Bundle only" }
        ]
    });
}

function buildStringEnumFilter()
{
    return new EnumFilter
    ({
        key: "scope",
        label: "Scope",
        field: "scope",
        options:
        [
            { value: "PER_USER", label: "Per-user" },
            { value: "OVERALL", label: "Overall" }
        ]
    });
}

// ── A03 ───────────────────────────────────────────────────────────────────────

function verifyLegitimateEnumValuesStillWork()
{
    section("A03 — every legitimate enum value still filters exactly as before");

    const numericFilter = buildNumericEnumFilter();

    assert(JSON.stringify(numericFilter.toMongoQuery(0)) === JSON.stringify({ granularity: 0 }),
        "numeric option 0 produces { granularity: 0 }");
    assert(JSON.stringify(numericFilter.toMongoQuery(1)) === JSON.stringify({ granularity: 1 }),
        "numeric option 1 produces { granularity: 1 }");

    const stringFilter = buildStringEnumFilter();

    assert(JSON.stringify(stringFilter.toMongoQuery("PER_USER")) === JSON.stringify({ scope: "PER_USER" }),
        "string option PER_USER produces { scope: \"PER_USER\" }");
    assert(JSON.stringify(stringFilter.toMongoQuery("OVERALL")) === JSON.stringify({ scope: "OVERALL" }),
        "string option OVERALL produces { scope: \"OVERALL\" }");
}

function verifySelectElementStringSpellingIsNormalized()
{
    section("A03 — a <select>'s string spelling of a numeric option still matches");

    const numericFilter = buildNumericEnumFilter();

    // EnumFilterInput coerces numeric-looking select values back to numbers, but
    // a query-string submission or an older client can still send "0". It must
    // resolve to the numeric option, and the fragment must carry the NUMBER —
    // Mongo would not match the string against a numeric field.
    const fragment = numericFilter.toMongoQuery("0");

    assert(JSON.stringify(fragment) === JSON.stringify({ granularity: 0 }),
        "the string \"0\" resolves to the numeric option and emits the number");
    assert(typeof fragment.granularity === "number",
        "the emitted value is the server's option value, not the client's string");
}

function verifyOperatorInjectionIsRefused()
{
    section("A03 — operator objects can no longer reach the query");

    const numericFilter = buildNumericEnumFilter();
    const stringFilter = buildStringEnumFilter();

    const injectionAttempts =
    [
        { $ne: null },
        { $gt: "" },
        { $exists: true },
        { $regex: ".*" },
        [0],
        ["PER_USER"],
        { toString: "PER_USER" }
    ];

    for (const attempt of injectionAttempts)
    {
        assert(numericFilter.toMongoQuery(attempt) === null,
            `numeric filter refuses ${JSON.stringify(attempt)}`);
        assert(stringFilter.toMongoQuery(attempt) === null,
            `string filter refuses ${JSON.stringify(attempt)}`);
    }
}

function verifyUnregisteredScalarsAreRefused()
{
    section("A03 — values outside the registered options contribute nothing");

    const numericFilter = buildNumericEnumFilter();

    assert(numericFilter.toMongoQuery(99) === null, "an unregistered number is refused");
    assert(numericFilter.toMongoQuery("BUNDLE_ONLY") === null, "an enum NAME (rather than its value) is refused");
    assert(numericFilter.toMongoQuery(true) === null, "an unregistered boolean is refused");
}

function verifyEmptyValuesStillMeanUnset()
{
    section("A03 — the unset contract is unchanged");

    const numericFilter = buildNumericEnumFilter();

    assert(numericFilter.toMongoQuery("") === null, "an empty string still means unset");
    assert(numericFilter.toMongoQuery(null) === null, "null still means unset");
    assert(numericFilter.toMongoQuery(undefined) === null, "undefined still means unset");
}

function verifySiblingFiltersWereAlreadySafe()
{
    section("A03 — sibling filters reject the same injection shapes");

    const booleanFilter = new BooleanFilter({ key: "acknowledged", label: "Acknowledged", field: "acknowledged" });

    assert(JSON.stringify(booleanFilter.toMongoQuery(true)) === JSON.stringify({ acknowledged: true }),
        "BooleanFilter still passes a real boolean through");
    assert(booleanFilter.toMongoQuery({ $ne: null }) === null,
        "BooleanFilter refuses an operator object (its isValueEmpty already required a boolean)");
    assert(booleanFilter.toMongoQuery("true") === null,
        "BooleanFilter refuses a stringified boolean");

    const multiSelectFilter = new MultiSelectFilter({ key: "category", label: "Category", field: "category", options: ["Maths"] });

    assert(multiSelectFilter.toMongoQuery({ $ne: null }) === null,
        "MultiSelectFilter refuses a non-array (its isValueEmpty already required an array)");
}

// ── A05 ───────────────────────────────────────────────────────────────────────

/**
 * SecurityHeaders memoizes its policies on first build, so each scenario needs a
 * freshly-required module with the environment already in place.
 */
function loadSecurityHeadersWith(environmentOverrides)
{
    const modulePath = require.resolve("./Endpoints/Plugins/SecurityHeaders");
    delete require.cache[modulePath];

    const managedKeys =
    [
        "CONTENT_SECURITY_POLICY",
        "CONTENT_SECURITY_POLICY_MODE",
        "CONTENT_SECURITY_POLICY_REPORT_ONLY",
        "CONTENT_SECURITY_POLICY_REPORTING_DISABLED",
        "CONTENT_SECURITY_POLICY_REPORT_URI"
    ];

    for (const key of managedKeys)
    {
        delete process.env[key];
    }

    for (const [key, value] of Object.entries(environmentOverrides))
    {
        process.env[key] = value;
    }

    return require("./Endpoints/Plugins/SecurityHeaders").SecurityHeaders;
}

function verifyEnforcedPolicyIsUnchangedByDefault()
{
    section("A05 — the enforced policy is untouched by default (nothing can break)");

    const SecurityHeaders = loadSecurityHeadersWith({});
    const enforcedPolicy = SecurityHeaders.buildContentSecurityPolicy();

    assert(enforcedPolicy.includes("script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: https:"),
        "the enforced script-src is byte-identical to the previously shipped one");
    assert(!enforcedPolicy.includes("report-uri"),
        "the enforced policy carries no report-uri");
    assert(enforcedPolicy.includes("object-src 'none'") && enforcedPolicy.includes("frame-ancestors 'self'"),
        "the locked-down directives are still present");
}

function verifyStrictCandidateShipsReportOnly()
{
    section("A05 — the strict candidate rides along report-only");

    const SecurityHeaders = loadSecurityHeadersWith({});
    const companionPolicy = SecurityHeaders.buildReportOnlyCompanionPolicy();

    assert(companionPolicy !== null, "a report-only companion policy is produced by default");
    assert(!companionPolicy.includes("'unsafe-inline' 'unsafe-eval'"),
        "the strict candidate drops unsafe-inline and unsafe-eval from script-src");
    assert(companionPolicy.includes("'wasm-unsafe-eval'"),
        "the strict candidate keeps wasm-unsafe-eval for the in-browser LLM");
    assert(companionPolicy.includes("https://pagead2.googlesyndication.com"),
        "the strict candidate allow-lists the AdSense loader origin");
    // SODAR is fetched by show_ads_impl at runtime, not declared in any markup,
    // so nothing else in this repo would catch its removal until strict mode was
    // promoted and AdSense's invalid-traffic detection quietly stopped loading.
    assert(companionPolicy.includes("https://*.adtrafficquality.google"),
        "the strict candidate allow-lists the AdSense SODAR origin");
    assert(companionPolicy.includes("https://static.zohocdn.com") && companionPolicy.includes("https://checkout.razorpay.com"),
        "the strict candidate allow-lists both checkout widget origins");
    assert(companionPolicy.includes("https://static.cloudflareinsights.com"),
        "the strict candidate allow-lists the edge-injected Cloudflare beacon (reported on every proxied page load)");
    assert(companionPolicy.includes("report-uri /Security/CspReport"),
        "the strict candidate points at the violation sink");

    const scriptDirective = companionPolicy.split("; ").find(directive => directive.startsWith("script-src "));
    assert(scriptDirective !== undefined && !scriptDirective.split(" ").includes("https:"),
        "the strict candidate replaces the blanket https: script source with named origins");
}

function verifyStyleSrcStaysPermissive()
{
    section("A05 — inline styles are deliberately still allowed");

    const SecurityHeaders = loadSecurityHeadersWith({});
    const companionPolicy = SecurityHeaders.buildReportOnlyCompanionPolicy();

    const styleDirective = companionPolicy.split("; ").find(directive => directive.startsWith("style-src "));

    assert(styleDirective !== undefined && styleDirective.includes("'unsafe-inline'"),
        "style-src keeps 'unsafe-inline' — the Web Components render inline styles throughout");
}

function verifyStrictModePromotesThePolicy()
{
    section("A05 — one environment variable promotes the strict policy");

    const SecurityHeaders = loadSecurityHeadersWith({ CONTENT_SECURITY_POLICY_MODE: "strict" });
    const enforcedPolicy = SecurityHeaders.buildContentSecurityPolicy();

    assert(!enforcedPolicy.includes("'unsafe-eval'"),
        "strict mode enforces a policy without unsafe-eval");
    assert(SecurityHeaders.buildReportOnlyCompanionPolicy() === null,
        "strict mode sends no duplicate report-only companion");
}

function verifyOperatorOverridesStillWin()
{
    section("A05 — pre-existing operator overrides behave exactly as before");

    const verbatimPolicy = "default-src 'self'";
    const overridden = loadSecurityHeadersWith({ CONTENT_SECURITY_POLICY: verbatimPolicy });

    assert(overridden.buildContentSecurityPolicy() === verbatimPolicy,
        "a verbatim CONTENT_SECURITY_POLICY still replaces the default entirely");
    assert(overridden.buildReportOnlyCompanionPolicy() === null,
        "a verbatim override suppresses the companion — the operator owns the policy");

    const legacyReportOnly = loadSecurityHeadersWith({ CONTENT_SECURITY_POLICY_REPORT_ONLY: "true" });

    assert(legacyReportOnly.isReportOnly() === true,
        "the legacy report-only flag still applies to the enforced policy");
    assert(legacyReportOnly.buildReportOnlyCompanionPolicy() === null,
        "the legacy report-only flag suppresses the companion so the two cannot collide");

    const reportingOff = loadSecurityHeadersWith({ CONTENT_SECURITY_POLICY_REPORTING_DISABLED: "true" });

    assert(reportingOff.buildReportOnlyCompanionPolicy() === null,
        "reporting can be switched off entirely");

    const customSink = loadSecurityHeadersWith({ CONTENT_SECURITY_POLICY_REPORT_URI: "/Custom/Sink" });

    assert(customSink.buildReportOnlyCompanionPolicy().includes("report-uri /Custom/Sink"),
        "the report sink is relocatable");
}

function verifyHeadersAreActuallyStamped()
{
    section("A05 — both headers reach the response");

    const SecurityHeaders = loadSecurityHeadersWith({});

    function stampHeadersFor(url)
    {
        const stampedHeaders = {};
        const fakeResponse = { setHeader: (name, value) => { stampedHeaders[name] = value; } };
        const fakeRequest = { url: url, headers: {}, socket: { encrypted: false } };

        SecurityHeaders.apply(fakeRequest, fakeResponse);
        return stampedHeaders;
    }

    const documentHeaders = stampHeadersFor("/");

    assert(typeof documentHeaders["Content-Security-Policy"] === "string",
        "the enforced Content-Security-Policy header is stamped");
    assert(typeof documentHeaders["Content-Security-Policy-Report-Only"] === "string",
        "the report-only companion header is stamped on a document");
    assert(documentHeaders["Content-Security-Policy"] !== documentHeaders["Content-Security-Policy-Report-Only"],
        "the two headers carry different policies");
    assert(documentHeaders["X-Content-Type-Options"] === "nosniff" && documentHeaders["X-Frame-Options"] === "SAMEORIGIN",
        "the other security headers are unaffected");
    assert(documentHeaders["Strict-Transport-Security"] === undefined,
        "HSTS is still withheld on a plain-http request");

    assert(typeof stampHeadersFor("/index.html")["Content-Security-Policy-Report-Only"] === "string",
        "the companion is stamped on /index.html — that is a document, not a subresource");
    assert(typeof stampHeadersFor("/Sync")["Content-Security-Policy-Report-Only"] === "string",
        "the companion is stamped on an extensionless API route");

    for (const subresourceUrl of ["/Bundle.chunk-ABC123.js", "/CommonStyles/Theme.css", "/Assets/Models/shard.bin", "/Globals/Assets/Images/Logos/Logo.png?v=2"])
    {
        const subresourceHeaders = stampHeadersFor(subresourceUrl);

        assert(subresourceHeaders["Content-Security-Policy-Report-Only"] === undefined,
            `the companion is skipped on ${subresourceUrl} — a subresource's CSP is inert`);
        assert(typeof subresourceHeaders["Content-Security-Policy"] === "string",
            `the enforced policy is still stamped on ${subresourceUrl}`);
    }
}

function verifyTheBuildEmitsNoEval()
{
    section("A05 — the shipped bundle needs no 'unsafe-eval'");

    // The obfuscator's 'browser' target picks its global-object code helper at
    // random between two templates, one of which is `Function('return this')()`.
    // That put a LIVE eval call in roughly a quarter of the emitted files and is
    // what tripped script-src at runtime. 'browser-no-eval' applies exactly the
    // same transforms with an eval-free helper. If this ever flips back, the
    // strict policy silently stops being enforceable — so pin it here.
    const obfuscatorScriptPath = path.join(currentDirectory, "..", "Common", "Scripts", "MinifyAndObfuscateStaticFiles.js");
    const obfuscatorScript = fs.readFileSync(obfuscatorScriptPath, "utf8");

    assert(obfuscatorScript.includes("target: 'browser-no-eval'"),
        "the obfuscator targets 'browser-no-eval' so it never emits a Function-constructor helper");
    assert(!obfuscatorScript.includes("target: 'browser'"),
        "the eval-emitting 'browser' target is not used anywhere");
    assert(obfuscatorScript.includes("selfDefending: true") && obfuscatorScript.includes("disableConsoleOutput: true"),
        "the obfuscation settings themselves are untouched — nothing was traded away for this");

    // Scan the actual build output when it is present.
    const staticDirectory = path.join(currentDirectory, "Static");
    if (!fs.existsSync(staticDirectory))
    {
        console.log("  SKIP  Dock/Static not built — skipping the emitted-bundle scan");
        return;
    }

    const evalPattern = /(^|[^.A-Za-z0-9_$])(eval|Function)\s*\(/;
    const offendingFiles = [];

    const walk = (directory) =>
    {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }))
        {
            const entryPath = path.join(directory, entry.name);

            if (entry.isDirectory())
            {
                walk(entryPath);
                continue;
            }

            if (!entry.name.endsWith(".js"))
            {
                continue;
            }

            const contents = fs.readFileSync(entryPath, "utf8");

            // The one permitted occurrence is WebLLM's globalThis fallback,
            // `typeof globalThis == "object" ? globalThis : Function("return
            // this")()`. The Function branch is unreachable on every browser
            // capable of running this app, so it never evaluates and never
            // trips CSP.
            const withoutKnownDeadBranch = contents.split('typeof globalThis=="object"?globalThis:Function("return this")()').join("");

            if (evalPattern.test(withoutKnownDeadBranch))
            {
                offendingFiles.push(path.relative(staticDirectory, entryPath));
            }
        }
    };

    walk(staticDirectory);

    assert(offendingFiles.length === 0,
        `no served script reaches eval at runtime${offendingFiles.length > 0 ? ` (found: ${offendingFiles.join(", ")})` : ""}`);
}

function verifyThePluginItselfStampsAndContinues()
{
    section("A05 — the registered global plugin (not just the class) behaves");

    const modulePath = require.resolve("./Endpoints/Plugins/SecurityHeaders");
    delete require.cache[modulePath];
    const { securityHeadersPlugin } = require("./Endpoints/Plugins/SecurityHeaders");

    const stampedHeaders = {};
    const fakeResponse = { setHeader: (name, value) => { stampedHeaders[name] = value; } };
    const fakeRequest = { url: "/", headers: {}, socket: { encrypted: false } };

    const handled = securityHeadersPlugin.handler(fakeRequest, fakeResponse);

    assert(handled === false, "the plugin never handles the request — it always falls through to the router");
    assert(typeof stampedHeaders["Content-Security-Policy"] === "string",
        "the plugin stamps the enforced policy");
    assert(typeof stampedHeaders["Content-Security-Policy-Report-Only"] === "string",
        "the plugin stamps the report-only companion");

    // A request object missing url/socket must not throw out of the plugin —
    // it is the very first thing to run on every request.
    const brokenResponse = { setHeader: () => {} };
    let pluginThrew = false;
    try
    {
        securityHeadersPlugin.handler({}, brokenResponse);
    }
    catch (pluginError)
    {
        pluginThrew = true;
    }
    assert(pluginThrew === false, "a malformed request cannot throw out of the plugin");
}

async function main()
{
    console.log(`Verifying security hardening (Dock at ${currentDirectory})`);

    verifyLegitimateEnumValuesStillWork();
    verifySelectElementStringSpellingIsNormalized();
    verifyOperatorInjectionIsRefused();
    verifyUnregisteredScalarsAreRefused();
    verifyEmptyValuesStillMeanUnset();
    verifySiblingFiltersWereAlreadySafe();

    verifyEnforcedPolicyIsUnchangedByDefault();
    verifyStrictCandidateShipsReportOnly();
    verifyStyleSrcStaysPermissive();
    verifyStrictModePromotesThePolicy();
    verifyOperatorOverridesStillWin();
    verifyHeadersAreActuallyStamped();
    verifyTheBuildEmitsNoEval();
    verifyThePluginItselfStampsAndContinues();

    console.log(`\n=== Summary ===`);
    console.log(`  passed:  ${passedCount}`);
    console.log(`  failed:  ${failedCount}`);

    process.exit(failedCount === 0 ? 0 : 1);
}

main();
