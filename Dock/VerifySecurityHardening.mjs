/**
 * End-to-end verification harness for the two security hardening fixes:
 *
 *   A03 — EnumFilter no longer passes a client-supplied value straight into a
 *         Mongo query fragment, so an operator object cannot be smuggled in.
 *   A05 — SecurityHeaders ENFORCES the strict Content-Security-Policy by
 *         default, with the permissive predecessor left reachable as a
 *         one-variable escape hatch.
 *
 * Run from the Dock directory:
 *     node VerifySecurityHardening.mjs
 *
 * Pure, in-process checks — no DB, no network, no Redis, so this always runs.
 *
 * The emphasis throughout is on proving that NOTHING LEGITIMATE BROKE: every
 * registered option of every registered EnumFilter must still produce exactly
 * the query fragment it produced before, and the enforced CSP must still name
 * every origin the application genuinely loads script from — an allow-list that
 * is now load-bearing rather than advisory, because it BLOCKS.
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

function verifyStrictPolicyIsEnforcedByDefault()
{
    section("A05 — the STRICT policy is the enforced one by default [B4]");

    const SecurityHeaders = loadSecurityHeadersWith({});
    const enforcedPolicy = SecurityHeaders.buildContentSecurityPolicy();

    // The whole point of the control: an injected inline <script> on a page
    // where a payment is taken must not run. Only a script-src without
    // 'unsafe-inline' achieves that, and only in the ENFORCED header.
    const scriptDirective = enforcedPolicy.split("; ").find(directive => directive.startsWith("script-src "));

    assert(scriptDirective !== undefined && !scriptDirective.includes("'unsafe-inline'"),
        "the enforced script-src blocks inline script");
    assert(scriptDirective !== undefined && !scriptDirective.includes("'unsafe-eval'"),
        "the enforced script-src blocks eval");
    assert(scriptDirective !== undefined && !scriptDirective.split(" ").includes("https:"),
        "the enforced script-src names origins instead of allowing any https: origin");
    assert(enforcedPolicy.includes("'wasm-unsafe-eval'"),
        "the enforced policy keeps wasm-unsafe-eval for the in-browser LLM");
    assert(enforcedPolicy.includes("object-src 'none'") && enforcedPolicy.includes("frame-ancestors 'self'"),
        "the locked-down directives are still present");
    assert(enforcedPolicy.includes("report-uri /Security/CspReport"),
        "enforcing does not blind the operator — the enforced policy still reports violations");
    assert(SecurityHeaders.buildReportOnlyCompanionPolicy() === null,
        "no duplicate report-only companion is sent when strict is already enforced");
}

function verifyEnforcedPolicyNamesEveryRealScriptOrigin()
{
    section("A05 — the enforced allow-list covers every origin the app really uses");

    // Under report-only a missing origin was a noisy alert. Enforced, it is a
    // broken feature, so each of these is now load-bearing.
    const SecurityHeaders = loadSecurityHeadersWith({});
    const enforcedPolicy = SecurityHeaders.buildContentSecurityPolicy();

    // Advertising was removed from the product, so its origins must be gone
    // from the allow-list too. Asserted as an ABSENCE rather than simply
    // deleted: an allow-list is a statement about what may execute on a page
    // that also hosts a checkout, and a stale entry there is exactly the kind
    // of thing that survives a feature removal unnoticed. If advertising ever
    // returns, this assertion is where the argument has to be made again.
    for (const removedAdvertisingOrigin of [
        "googlesyndication.com",
        "googletagservices.com",
        "doubleclick.net",
        "adtrafficquality.google",
        "gstatic.com",
    ])
    {
        assert(!enforcedPolicy.includes(removedAdvertisingOrigin),
            `no advertising origin may execute scripts: ${removedAdvertisingOrigin} is absent`);
    }

    assert(enforcedPolicy.includes("https://checkout.razorpay.com"),
        "the Razorpay checkout widget origin is allow-listed — without this, no payment can be taken at all");
    assert(enforcedPolicy.includes("https://static.cloudflareinsights.com"),
        "the edge-injected Cloudflare beacon is allow-listed (it is in no markup, so only this list covers it)");
}

function verifyStyleSrcStaysPermissive()
{
    section("A05 — inline styles are deliberately still allowed");

    const SecurityHeaders = loadSecurityHeadersWith({});
    const enforcedPolicy = SecurityHeaders.buildContentSecurityPolicy();

    const styleDirective = enforcedPolicy.split("; ").find(directive => directive.startsWith("style-src "));

    assert(styleDirective !== undefined && styleDirective.includes("'unsafe-inline'"),
        "style-src keeps 'unsafe-inline' — the Web Components render inline styles throughout");
}

function verifyCompatibleModeIsTheEscapeHatch()
{
    section("A05 — one environment variable rolls back to the permissive policy");

    const SecurityHeaders = loadSecurityHeadersWith({ CONTENT_SECURITY_POLICY_MODE: "compatible" });
    const enforcedPolicy = SecurityHeaders.buildContentSecurityPolicy();

    assert(enforcedPolicy.includes("script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: https:"),
        "compatible mode restores the previously shipped script-src byte-for-byte");
    assert(!enforcedPolicy.includes("report-uri"),
        "the compatible policy carries no report-uri of its own");

    const companionPolicy = SecurityHeaders.buildReportOnlyCompanionPolicy();

    assert(companionPolicy !== null,
        "the strict policy rides along report-only, so the evidence needed to return to strict keeps accumulating");
    const companionScriptDirective = companionPolicy.split("; ").find(directive => directive.startsWith("script-src "));

    assert(companionScriptDirective !== undefined && !companionScriptDirective.includes("'unsafe-inline'")
        && companionPolicy.includes("report-uri /Security/CspReport"),
        "the companion is the strict policy, pointed at the violation sink");

    // A mangled value must fail towards the safer policy, not away from it.
    for (const mangledValue of ["", "  ", "Strict", "compatable", "true"])
    {
        const mangled = loadSecurityHeadersWith({ CONTENT_SECURITY_POLICY_MODE: mangledValue });
        const mangledScriptDirective = mangled.buildContentSecurityPolicy().split("; ").find(directive => directive.startsWith("script-src "));

        assert(mangledScriptDirective !== undefined && !mangledScriptDirective.includes("'unsafe-inline'"),
            `CONTENT_SECURITY_POLICY_MODE="${mangledValue}" still enforces the strict policy`);
    }
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

    const reportingOff = loadSecurityHeadersWith({ CONTENT_SECURITY_POLICY_MODE: "compatible", CONTENT_SECURITY_POLICY_REPORTING_DISABLED: "true" });

    assert(reportingOff.buildReportOnlyCompanionPolicy() === null,
        "reporting can be switched off entirely");

    const customSink = loadSecurityHeadersWith({ CONTENT_SECURITY_POLICY_REPORT_URI: "/Custom/Sink" });

    assert(customSink.buildContentSecurityPolicy().includes("report-uri /Custom/Sink"),
        "the report sink is relocatable on the enforced policy");
}

function verifyHeadersAreActuallyStamped()
{
    section("A05 — the enforcing header reaches the response");

    function stamperFor(environmentOverrides)
    {
        const SecurityHeaders = loadSecurityHeadersWith(environmentOverrides);

        return (url) =>
        {
            const stampedHeaders = {};
            const fakeResponse = { setHeader: (name, value) => { stampedHeaders[name] = value; } };
            const fakeRequest = { url: url, headers: {}, socket: { encrypted: false } };

            SecurityHeaders.apply(fakeRequest, fakeResponse);
            return stampedHeaders;
        };
    }

    const stampHeadersFor = stamperFor({});
    const documentHeaders = stampHeadersFor("/");

    assert(typeof documentHeaders["Content-Security-Policy"] === "string",
        "the enforced Content-Security-Policy header is stamped");
    assert(!documentHeaders["Content-Security-Policy"].includes("'unsafe-inline' 'unsafe-eval'"),
        "the header that BLOCKS is the strict one — not a report-only companion");
    assert(documentHeaders["Content-Security-Policy-Report-Only"] === undefined,
        "no companion is stamped alongside it — the enforced policy already reports");
    assert(documentHeaders["X-Content-Type-Options"] === "nosniff" && documentHeaders["X-Frame-Options"] === "SAMEORIGIN",
        "the other security headers are unaffected");
    assert(documentHeaders["Strict-Transport-Security"] === undefined,
        "HSTS is still withheld on a plain-http request");

    for (const subresourceUrl of ["/Bundle.chunk-ABC123.js", "/CommonStyles/Theme.css", "/Assets/Models/shard.bin", "/Globals/Assets/Images/Logos/Logo.png?v=2"])
    {
        assert(typeof stampHeadersFor(subresourceUrl)["Content-Security-Policy"] === "string",
            `the enforced policy is stamped on ${subresourceUrl}`);
    }

    // The escape hatch must still produce the two-header shape, since that is
    // the state an operator rolls back into.
    const stampCompatibleHeadersFor = stamperFor({ CONTENT_SECURITY_POLICY_MODE: "compatible" });
    const compatibleDocumentHeaders = stampCompatibleHeadersFor("/");

    assert(typeof compatibleDocumentHeaders["Content-Security-Policy-Report-Only"] === "string",
        "rolled back, the report-only companion header is stamped on a document");
    assert(compatibleDocumentHeaders["Content-Security-Policy"] !== compatibleDocumentHeaders["Content-Security-Policy-Report-Only"],
        "rolled back, the two headers carry different policies");
    assert(typeof stampCompatibleHeadersFor("/index.html")["Content-Security-Policy-Report-Only"] === "string",
        "the companion is stamped on /index.html — that is a document, not a subresource");
    assert(typeof stampCompatibleHeadersFor("/Sync")["Content-Security-Policy-Report-Only"] === "string",
        "the companion is stamped on an extensionless API route");
    assert(stampCompatibleHeadersFor("/Bundle.chunk-ABC123.js")["Content-Security-Policy-Report-Only"] === undefined,
        "the companion is skipped on a subresource — a subresource's CSP is inert");
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

            // One construct is permitted: the "find the global object" fallback
            // that ships in WebLLM and again, in lodash's form, inside Mermaid —
            //
            //     typeof globalThis == "object" ? globalThis : Function("return this")()
            //     global || (typeof self == "object" && self.Object === Object && self) || Function("return this")()
            //
            // The Function branch is guarded by a check that is ALWAYS true in a
            // browser (globalThis and self both exist and are the global), so it
            // is never evaluated, never reaches the JS engine's compiler, and
            // never trips CSP. Both spellings are stripped rather than one
            // vendor's exact bytes, because the property being asserted is "no
            // eval RUNS", not "no eval appears".
            const knownDeadGlobalFallbacks =
            [
                'typeof globalThis=="object"?globalThis:Function("return this")()',
                '||Function("return this")()'
            ];
            let withoutKnownDeadBranch = contents;
            for (const deadFallback of knownDeadGlobalFallbacks)
            {
                withoutKnownDeadBranch = withoutKnownDeadBranch.split(deadFallback).join("");
            }

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

    // Load through the same helper the other checks use, so no environment an
    // earlier check set can leak in and make this one assert the wrong mode.
    loadSecurityHeadersWith({});
    const { securityHeadersPlugin } = require("./Endpoints/Plugins/SecurityHeaders");

    const stampedHeaders = {};
    const fakeResponse = { setHeader: (name, value) => { stampedHeaders[name] = value; } };
    const fakeRequest = { url: "/", headers: {}, socket: { encrypted: false } };

    const handled = securityHeadersPlugin.handler(fakeRequest, fakeResponse);

    assert(handled === false, "the plugin never handles the request — it always falls through to the router");
    assert(typeof stampedHeaders["Content-Security-Policy"] === "string",
        "the plugin stamps the enforced policy");
    assert(!stampedHeaders["Content-Security-Policy"].includes("'unsafe-inline' 'unsafe-eval'"),
        "the policy the plugin stamps is the strict, blocking one");

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

    verifyStrictPolicyIsEnforcedByDefault();
    verifyEnforcedPolicyNamesEveryRealScriptOrigin();
    verifyStyleSrcStaysPermissive();
    verifyCompatibleModeIsTheEscapeHatch();
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
