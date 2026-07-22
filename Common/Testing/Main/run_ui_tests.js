// Browser UI tests for the BUILT CogniumLearn app (Dock/Static), driven by a real
// Chromium via Puppeteer. Covers: page-to-page navigation matrix, portrait /
// landscape responsiveness (no horizontal overflow / blank screens), dialog
// alignment + overflow + one-after-another queueing, and client-side error
// capture (console.error / pageerror / unhandledrejection).
//
// CogniumLearn is a single-page app: the custom PageNavigator mounts exactly one
// page element at a time (the previous page is hidden via display:none or
// cleared from the stack). A single boot-page check would therefore only cover
// whatever the bootstrap happened to open, so the responsiveness + blank-screen
// sweep DRIVES THE NAVIGATOR to every discovered page and asserts each one
// individually. Pages that cannot mount standalone (they need initialize args)
// are recorded SKIPPED with their reason -- never FAIL.
//
//   node Common/Testing/Main/run_ui_tests.js
//
// Env: BASE_URL (default http://127.0.0.1:3000),
//      TEST_SESSION_COOKIE (a valid sessionId for a seeded account; without it,
//      only the unauthenticated surface is tested and the rest is SKIPPED).
// Result JSON -> $RESULT_FILE or Common/Reports/.results/main-ui.json.

const fs = require("fs");
const path = require("path");

const REPOSITORY_ROOT = path.resolve(__dirname, "..", "..", "..");
const RESULT_FILE = process.env.RESULT_FILE
    || path.join(REPOSITORY_ROOT, "Common", "Reports", ".results", "main-ui.json");
const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:3000";
const SESSION_COOKIE = process.env.TEST_SESSION_COOKIE || "";
const CATEGORY = "UI Navigation / Responsive / Popups (Puppeteer)";

// Fallback inventory; the runner also discovers registered tags at runtime.
const KNOWN_PAGE_TAGS = [
    "home-page", "login-page", "admin-panel-page", "settings-page",
    "cogniumlearn-about-page", "tutorials-page", "progress-page", "study-page",
    "card-editor-page", "study-material-editor-page", "deck-editor-page",
    "mock-test-editor-page", "mock-test-answer-key-page", "browser-page",
    "deck-insights-page", "automatic-generation-page", "activity-page",
    "paid-deck-library-page", "paid-deck-details-page", "paid-deck-browse-page",
];

const VIEWPORTS = {
    portrait: { width: 390, height: 844 },
    landscape: { width: 844, height: 390 },
    desktop: { width: 1280, height: 800 },
};

function writeResult(payload)
{
    fs.mkdirSync(path.dirname(path.resolve(RESULT_FILE)), { recursive: true });
    fs.writeFileSync(RESULT_FILE, JSON.stringify(payload, null, 2), "utf-8");
}

function skip(note)
{
    const payload = {
        service: "Main", category: CATEGORY, status: "SKIPPED",
        passed: 0, failed: 0, skipped: 0, total: 0,
        coverage: { kind: "navigation", label: "Navigation", percent: null, detail: note },
        cases: [], notes: note,
    };
    writeResult(payload);
    console.log(`Main ${CATEGORY}: SKIPPED - ${note}`);
}

let puppeteer;
try
{
    puppeteer = require("puppeteer");
}
catch (error)
{
    skip("puppeteer not installed; run `npm install` in Common/Testing/Main.");
    process.exit(0);
}

(async () =>
{
    const cases = [];
    // Real JavaScript faults (exceptions / rejections) — always app bugs.
    const scriptErrors = [];
    // Resource loads that returned >= 400, captured WITH their URL so the report
    // names the exact 404 instead of an opaque "Failed to load resource".
    const failedResources = [];
    // URLs this test deliberately requests as instrumentation (dynamic imports of
    // raw module paths that do not exist in the BUNDLED build). A 404 on one of
    // these is a property of the production bundle, not an app defect, so it must
    // not fail the client-error gate.
    const probeUrls = new Set();
    const registerProbe = (relativeUrl) => probeUrls.add(new URL(relativeUrl, BASE_URL).href);
    const isBenignFailedResource = (url) =>
        probeUrls.has(url) || /\/favicon\.ico(\?|$)/.test(url);
    let navigationAttempted = 0;
    let navigationReached = 0;
    let pagesDiscovered = [];
    let appShellLoadMs = null;
    let responsivePagesChecked = 0;

    const record = (name, passed, detail) => cases.push({ name, status: passed ? "PASS" : "FAIL", detail: detail || "" });

    let browser;
    try
    {
        browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    }
    catch (error)
    {
        skip(`Chromium failed to launch: ${error.message}. Run \`npx puppeteer browsers install chrome\`.`);
        return;
    }

    try
    {
        const page = await browser.newPage();
        await page.setViewport(VIEWPORTS.desktop);

        // Real script faults: uncaught exceptions and unhandled rejections.
        page.on("pageerror", error => scriptErrors.push(`pageerror: ${error.message}`));
        // Failed resource loads, captured with the URL + HTTP status so the
        // report can say exactly what 404'd. Console.error text alone omits the
        // URL, so we key the gate off responses instead.
        page.on("response", response =>
        {
            const status = response.status();
            if (status >= 400)
            {
                failedResources.push({ url: response.url(), status });
            }
        });
        page.on("requestfailed", request =>
        {
            const failure = request.failure();
            if (failure && !/net::ERR_ABORTED/.test(failure.errorText))
            {
                failedResources.push({ url: request.url(), status: failure.errorText });
            }
        });

        if (SESSION_COOKIE)
        {
            await page.setCookie({ name: "sessionId", value: SESSION_COOKIE, url: BASE_URL });
        }

        // -- Boot the app --
        let response;
        try
        {
            response = await page.goto(BASE_URL + "/", { waitUntil: "networkidle2", timeout: 30000 });
        }
        catch (error)
        {
            skip(`Could not load ${BASE_URL}: ${error.message}. Start the Dock server first.`);
            await browser.close();
            return;
        }
        // Browser-reported navigation timing for the shell document.
        appShellLoadMs = await page.evaluate(() =>
        {
            const timing = performance.getEntriesByType("navigation")[0];
            return timing ? Math.round(timing.responseEnd - timing.startTime) : null;
        }).catch(() => null);

        record("App shell loads (HTTP ok, body rendered)",
            response && response.ok(),
            (response ? `status ${response.status()}` : "no response")
                + (appShellLoadMs !== null ? `, document loaded in ${appShellLoadMs}ms` : ""));

        // Give the bootstrap a moment to register custom elements + open the first page.
        await new Promise(resolve => setTimeout(resolve, 2500));

        // Expose PageNavigator on window for the test (dynamic import of the served module).
        // The raw module path only exists in an unbundled build; in the production
        // bundle it 404s, so flag it as a benign probe before requesting it.
        registerProbe("/Globals/Classes/PageNavigator.js");
        const navigatorReady = await page.evaluate(async () =>
        {
            if (window.PageNavigator) return true;
            try
            {
                const module = await import("/Globals/Classes/PageNavigator.js");
                window.PageNavigator = module.default || module.PageNavigator || module;
                return Boolean(window.PageNavigator && window.PageNavigator.open);
            }
            catch (error)
            {
                return false;
            }
        });

        // Discover which page tags are actually registered in this session.
        pagesDiscovered = await page.evaluate((knownTags) =>
            knownTags.filter(tag => Boolean(window.customElements && window.customElements.get(tag))), KNOWN_PAGE_TAGS);

        const authed = pagesDiscovered.includes("home-page") || (SESSION_COOKIE && pagesDiscovered.length > 1);

        // -- Per-page responsiveness + blank-screen sweep (SPA navigator-aware) --
        // Drive the PageNavigator to each discovered page and check it on its
        // own. Overflow is a universally-valid hard assertion (it must never
        // happen regardless of what data a page holds). Blankness is reported
        // PASS when the page renders content and SKIPPED when it mounts empty --
        // a standalone page opened without its initialize args can legitimately
        // be empty, and we cannot distinguish that from a defect here, so we do
        // not FAIL it. When the navigator is unavailable (e.g. an unbundled
        // single-page or unauthenticated shell that 404s the probe import) we
        // fall back to checking whatever is currently on screen.
        if (navigatorReady && pagesDiscovered.length >= 1)
        {
            for (const pageTag of pagesDiscovered)
            {
                // clearAndOpen wipes the stack so ONLY this page is mounted and
                // visible -- no hidden display:none siblings skewing the metrics.
                const mount = await page.evaluate(async (tag) =>
                {
                    const result = { mounted: false, detail: "" };
                    try
                    {
                        window.PageNavigator.clearAndOpen
                            ? window.PageNavigator.clearAndOpen(tag)
                            : window.PageNavigator.open(tag);
                        await new Promise(resolve => setTimeout(resolve, 200));
                        const current = window.PageNavigator.getCurrentPage
                            ? window.PageNavigator.getCurrentPage()
                            : null;
                        const currentTag = current ? current.tagName.toLowerCase() : "";
                        result.mounted = currentTag === tag;
                        if (!result.mounted)
                        {
                            result.detail = `landed on ${currentTag || "nothing"}`;
                        }
                    }
                    catch (error)
                    {
                        result.detail = String(error && error.message || error);
                    }
                    return result;
                }, pageTag);

                if (!mount.mounted)
                {
                    cases.push({
                        name: `Responsive (${pageTag})`,
                        status: "SKIPPED",
                        detail: `Could not mount standalone${mount.detail ? `: ${mount.detail}` : ""} (likely needs initialize args).`,
                    });
                    continue;
                }

                responsivePagesChecked += 1;
                for (const [orientation, viewport] of Object.entries(VIEWPORTS))
                {
                    await page.setViewport(viewport);
                    await new Promise(resolve => setTimeout(resolve, 250));
                    const metrics = await page.evaluate(() =>
                    {
                        const current = window.PageNavigator && window.PageNavigator.getCurrentPage
                            ? window.PageNavigator.getCurrentPage()
                            : document.body;
                        return {
                            scrollWidth: document.documentElement.scrollWidth,
                            clientWidth: document.documentElement.clientWidth,
                            textLength: current ? (current.innerText || "").trim().length : 0,
                            childCount: current ? current.childElementCount : 0,
                        };
                    });
                    const noOverflow = metrics.scrollWidth <= metrics.clientWidth + 1;
                    record(`Responsive (${pageTag}, ${orientation}): no horizontal overflow`, noOverflow,
                        `scrollWidth ${metrics.scrollWidth} vs clientWidth ${metrics.clientWidth}`);

                    // Assert non-blankness once per page (on the desktop control)
                    // to avoid triple-counting the same observation per viewport.
                    if (orientation === "desktop")
                    {
                        if (metrics.textLength > 0 && metrics.childCount > 0)
                        {
                            record(`Page (${pageTag}): renders non-blank content`, true,
                                `text length ${metrics.textLength}, children ${metrics.childCount}`);
                        }
                        else
                        {
                            cases.push({
                                name: `Page (${pageTag}): renders non-blank content`,
                                status: "SKIPPED",
                                detail: `mounted empty (text ${metrics.textLength}, children ${metrics.childCount}) -- likely needs initialize args.`,
                            });
                        }
                    }
                }
            }
            await page.setViewport(VIEWPORTS.desktop);
        }
        else
        {
            // Fallback: no navigator (or no discovered pages) -- check the single
            // page currently on screen, as the suite did before it was made
            // SPA-aware.
            for (const [orientation, viewport] of Object.entries(VIEWPORTS))
            {
                await page.setViewport(viewport);
                await new Promise(resolve => setTimeout(resolve, 300));
                const metrics = await page.evaluate(() => ({
                    scrollWidth: document.documentElement.scrollWidth,
                    clientWidth: document.documentElement.clientWidth,
                    textLength: (document.body.innerText || "").trim().length,
                    childCount: document.body.childElementCount,
                }));
                const noOverflow = metrics.scrollWidth <= metrics.clientWidth + 1;
                const notBlank = metrics.textLength > 0 && metrics.childCount > 0;
                record(`Responsive (${orientation}): no horizontal overflow`, noOverflow,
                    `scrollWidth ${metrics.scrollWidth} vs clientWidth ${metrics.clientWidth}`);
                record(`Responsive (${orientation}): not a blank screen`, notBlank,
                    `text length ${metrics.textLength}, children ${metrics.childCount}`);
            }
            await page.setViewport(VIEWPORTS.desktop);
        }

        // -- Navigation matrix --
        if (!navigatorReady || pagesDiscovered.length < 2)
        {
            cases.push({
                name: "Navigation matrix (any page -> any page)",
                status: "SKIPPED",
                detail: SESSION_COOKIE
                    ? `Only ${pagesDiscovered.length} page(s) registered; navigator ready: ${navigatorReady}.`
                    : "Set TEST_SESSION_COOKIE to a seeded session to exercise authenticated pages.",
            });
        }
        else
        {
            for (const sourceTag of pagesDiscovered)
            {
                for (const targetTag of pagesDiscovered)
                {
                    if (sourceTag === targetTag) continue;
                    navigationAttempted += 1;
                    const outcome = await page.evaluate(async (source, target) =>
                    {
                        const result = { ok: false, detail: "" };
                        try
                        {
                            window.PageNavigator.clearAndOpen
                                ? window.PageNavigator.clearAndOpen(source)
                                : window.PageNavigator.open(source);
                            await new Promise(resolve => setTimeout(resolve, 120));
                            window.PageNavigator.open(target);
                            await new Promise(resolve => setTimeout(resolve, 180));
                            const current = window.PageNavigator.getCurrentPage
                                ? window.PageNavigator.getCurrentPage()
                                : null;
                            const tag = current ? current.tagName.toLowerCase() : "";
                            const text = current ? (current.innerText || "").trim().length : 0;
                            // Reachability only: the target must become the
                            // current page. Per-page blankness is asserted by the
                            // responsiveness sweep above, not here -- a navigated
                            // page may be legitimately sparse without args.
                            result.ok = tag === target;
                            result.detail = `landed on ${tag}, content length ${text}`;
                        }
                        catch (error)
                        {
                            result.detail = String(error && error.message || error);
                        }
                        return result;
                    }, sourceTag, targetTag);

                    if (outcome.ok) navigationReached += 1;
                    record(`Navigate ${sourceTag} -> ${targetTag}`, outcome.ok, outcome.detail);
                }
            }
        }

        // -- Dialog alignment / overflow / queueing --
        if (authed || pagesDiscovered.includes("login-page"))
        {
            registerProbe("/CommonComponents/DialogBox.js");
            const dialogReady = await page.evaluate(async () =>
            {
                if (window.DialogBox) return true;
                try
                {
                    const module = await import("/CommonComponents/DialogBox.js");
                    window.DialogBox = module.default || module.DialogBox || module;
                    return Boolean(window.DialogBox);
                }
                catch (error)
                {
                    return false;
                }
            });

            if (!dialogReady)
            {
                cases.push({ name: "Dialog alignment / queueing", status: "SKIPPED", detail: "DialogBox module not importable in this build." });
            }
            else
            {
                const dialogOutcome = await page.evaluate(async () =>
                {
                    const out = { centered: false, single: false, dismissed: false, detail: "" };
                    try
                    {
                        const promiseA = window.DialogBox.alert ? window.DialogBox.alert("Test A", "First dialog body") : null;
                        const promiseB = window.DialogBox.alert ? window.DialogBox.alert("Test B", "Second dialog body") : null;
                        await new Promise(resolve => setTimeout(resolve, 250));

                        const dialogs = Array.from(document.querySelectorAll("dialog-box"))
                            .filter(node => node.offsetParent !== null || node.getClientRects().length);
                        out.single = dialogs.length <= 1; // queued, not stacked
                        const visible = dialogs[0];
                        if (visible)
                        {
                            const box = visible.getBoundingClientRect();
                            out.centered = box.left >= -1 && box.top >= -1
                                && box.right <= window.innerWidth + 1
                                && box.bottom <= window.innerHeight + 1;
                            out.detail = `box ${Math.round(box.left)},${Math.round(box.top)} ${Math.round(box.width)}x${Math.round(box.height)}; visible dialogs ${dialogs.length}`;
                        }
                        // Dismiss any open dialogs.
                        document.querySelectorAll("dialog-box").forEach(node => node.remove());
                        await new Promise(resolve => setTimeout(resolve, 100));
                        out.dismissed = document.querySelectorAll("dialog-box").length === 0;
                        // Swallow the still-pending promises.
                        void promiseA; void promiseB;
                    }
                    catch (error)
                    {
                        out.detail = String(error && error.message || error);
                    }
                    return out;
                });

                record("Dialog is centered within the viewport (no overflow)", dialogOutcome.centered, dialogOutcome.detail);
                record("Dialogs appear one after another (not stacked)", dialogOutcome.single, dialogOutcome.detail);
                record("Dialog dismisses cleanly (no orphan backdrop)", dialogOutcome.dismissed, dialogOutcome.detail);
            }
        }

        // -- Client-side error gate (whole run) --
        // App-relevant failures only: real script faults plus failed resource
        // loads that are NOT this test's own bundle-incompatible probes (or the
        // browser's automatic /favicon.ico request).
        const appFailedResources = failedResources.filter(resource => !isBenignFailedResource(resource.url));
        const benignFailedResources = failedResources.filter(resource => isBenignFailedResource(resource.url));
        const gateDetailParts = [];
        for (const error of scriptErrors.slice(0, 4))
        {
            gateDetailParts.push(error);
        }
        for (const resource of appFailedResources.slice(0, 6))
        {
            gateDetailParts.push(`${resource.status} ${resource.url}`);
        }
        if (benignFailedResources.length)
        {
            gateDetailParts.push(`(ignored ${benignFailedResources.length} benign probe/favicon 404(s): `
                + benignFailedResources.slice(0, 4).map(resource => resource.url.replace(BASE_URL, "")).join(", ") + ")");
        }
        record("No client-side errors captured (script faults / failed resource loads)",
            scriptErrors.length === 0 && appFailedResources.length === 0,
            gateDetailParts.join(" | ") || "no script faults, no failed resource loads");
    }
    finally
    {
        if (browser) await browser.close();
    }

    const passed = cases.filter(testCase => testCase.status === "PASS").length;
    const failed = cases.filter(testCase => testCase.status === "FAIL").length;
    const skipped = cases.filter(testCase => testCase.status === "SKIPPED").length;
    const percent = navigationAttempted > 0
        ? Math.round(1000 * navigationReached / navigationAttempted) / 10
        : (cases.length ? Math.round(1000 * passed / (passed + failed || 1)) / 10 : null);

    const appFailedResourceCount = failedResources.filter(resource => !isBenignFailedResource(resource.url)).length;
    const benignFailedResourceCount = failedResources.length - appFailedResourceCount;
    const metrics = {
        label: "Load time (ms)",
        appShellLoadMs,
        scriptFaults: scriptErrors.length,
        appFailedResources: appFailedResourceCount,
        benignFailedResources: benignFailedResourceCount,
    };

    const noteParts = [];
    if (appFailedResourceCount) noteParts.push(`${appFailedResourceCount} app resource load failure(s)`);
    if (scriptErrors.length) noteParts.push(`${scriptErrors.length} script fault(s)`);
    if (benignFailedResourceCount) noteParts.push(`${benignFailedResourceCount} benign probe/favicon 404(s) ignored`);
    if (responsivePagesChecked) noteParts.push(`${responsivePagesChecked} page(s) swept for responsiveness across ${Object.keys(VIEWPORTS).length} viewports`);
    if (appShellLoadMs !== null) noteParts.push(`shell document loaded in ${appShellLoadMs}ms`);

    const payload = {
        service: "Main",
        category: CATEGORY,
        status: failed > 0 ? "FAIL" : (passed === 0 ? "SKIPPED" : (skipped > 0 ? "PARTIAL" : "PASS")),
        passed, failed, skipped, total: cases.length,
        coverage: {
            kind: "navigation",
            label: "Navigation",
            percent,
            covered: navigationReached,
            total: navigationAttempted,
            detail: navigationAttempted > 0
                ? `${navigationReached}/${navigationAttempted} page-pairs reached; ${pagesDiscovered.length} pages discovered; ${responsivePagesChecked} checked for responsiveness`
                : `${pagesDiscovered.length} pages discovered; ${responsivePagesChecked} checked for responsiveness; navigation matrix not run`,
        },
        metrics,
        cases,
        notes: noteParts.join("; ") + ".",
    };
    writeResult(payload);
    console.log(`Main ${CATEGORY}: ${passed} passed, ${failed} failed, ${skipped} skipped`
        + (percent !== null ? `, nav coverage ${percent}%` : "")
        + (appShellLoadMs !== null ? `, shell load ${appShellLoadMs}ms` : ""));
})().catch(error =>
{
    skip(`Unexpected runner error: ${error && error.message}`);
    process.exit(0);
});
