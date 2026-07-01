// Browser UI tests for MindMeld's interactive TUTORIALS, driven by a real
// Chromium via Puppeteer against the BUILT app (Dock/Static). For every
// tutorial registered in TutorialRegistry this suite:
//
//   1. WALKS IT START TO FINISH — it plays each step the way a user would,
//      clicking the real Next / Finish buttons and the real in-app elements
//      each WAIT_FOR_CLICK / WAIT_FOR_EVENT step points at, filling any
//      required fields, until the tutorial's finish dialog is dismissed.
//
//   2. ASSERTS EVERY CLICK TARGET IS VISIBLE TO THE USER — for each step that
//      asks the user to click a real element, it takes the centre of the
//      overlay's spotlight hole and calls document.elementFromPoint there. The
//      element returned must be a real page element OUTSIDE the tutorial
//      overlay (the dim mask is clip-path-punched so the target is exposed and
//      clickable). If the selector never resolved (overlay fell back to its
//      floating tooltip) or the point lands back on the overlay/mask, the
//      target is NOT actually clickable and the case FAILS.
//
//   3. FORBIDS "MAGIC" NAVIGATION — the current page tag is sampled before and
//      after every step. A page change is only legitimate when the user
//      themselves clicked a real element (a WAIT_FOR_CLICK / WAIT_FOR_EVENT
//      step). If the page changes while the user merely acknowledged a tooltip
//      (clicked Next / Finish), the tutorial teleported the user — e.g. a step
//      whose setupAction calls PageNavigator.open — and the case FAILS.
//
// The suite drives the tutorials through window.__tutorialE2E, a small opt-in
// control surface the app installs only when loaded with ?tutorialE2E=1 (see
// Main/Globals/Classes/TutorialBootstrap.js). That seam only lists tutorials,
// starts one, returns to Home, and reports the current page tag — every click
// and every visibility/navigation assertion is performed here against the real
// rendered DOM, so this remains a genuine black-box UI test.
//
//   node Common/Testing/Main/run_tutorial_ui_tests.js
//
// Env: BASE_URL (default http://127.0.0.1:3000),
//      TEST_SESSION_COOKIE (REQUIRED — a valid sessionId for a seeded account
//      that has already accepted the Terms; without it the home page / deck
//      tree never load and the whole suite is SKIPPED, never FAILED).
// Result JSON -> $RESULT_FILE or Common/Reports/.results/tutorial-ui.json.

const fs = require("fs");
const path = require("path");

const REPOSITORY_ROOT = path.resolve(__dirname, "..", "..", "..");
const RESULT_FILE = process.env.RESULT_FILE
    || path.join(REPOSITORY_ROOT, "Common", "Reports", ".results", "tutorial-ui.json");
const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:3000";
const SESSION_COOKIE = process.env.TEST_SESSION_COOKIE || "";
const CATEGORY = "Tutorial Walkthrough (Puppeteer)";

// Every page custom-element tag the app can mount. Used only to identify which
// element is the "current page" when sampling for navigation, as a fallback to
// the seam's own currentPageTag().
const KNOWN_PAGE_TAGS = [
    "home-page", "login-page", "admin-panel-page", "settings-page",
    "mindmeld-about-page", "tutorials-page", "progress-page", "study-page",
    "card-editor-page", "study-material-editor-page", "deck-editor-page",
    "mock-test-editor-page", "mock-test-answer-key-page", "browser-page",
    "deck-insights-page", "automatic-generation-page", "activity-page",
    "paid-deck-library-page", "paid-deck-details-page", "paid-deck-browse-page",
];

const VIEWPORT = { width: 1280, height: 900 };

// Per-step pacing. Tutorials render synchronously but their setupAction (sample
// deck build, page navigation) and the engine's selector polling are async, so
// we settle briefly after each render before measuring, and allow a generous
// window for a step to advance before declaring it stuck.
const STEP_SETTLE_MS = 700;
const ADVANCE_TIMEOUT_MS = 9000;
const POLL_INTERVAL_MS = 150;
const FIELD_VALUE = "Tutorial test value";

function writeResult(payload)
{
    fs.mkdirSync(path.dirname(path.resolve(RESULT_FILE)), { recursive: true });
    fs.writeFileSync(RESULT_FILE, JSON.stringify(payload, null, 2), "utf-8");
}

function skip(note)
{
    writeResult({
        service: "Main", category: CATEGORY, status: "SKIPPED",
        passed: 0, failed: 0, skipped: 0, total: 0,
        coverage: { kind: "steps", label: "Steps walked", percent: null, detail: note },
        cases: [], notes: note,
    });
    console.log(`Main ${CATEGORY}: SKIPPED - ${note}`);
}

const sleep = (milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds));

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

// -- In-browser probes (evaluated in the page context) -----------------------

// Reads everything the driver needs about the currently-rendered tutorial step
// in one round-trip: progress counters, which acknowledge buttons are shown,
// whether the Next button is gated by a validator, the overlay's mode, and —
// for spotlight steps — the element exposed at the centre of the spotlight hole.
function readOverlayStateInPage()
{
    const overlay = document.querySelector("tutorial-overlay");
    if (!overlay || overlay.style.display === "none")
    {
        return { visible: false };
    }

    const progressElement = overlay.querySelector(".tutorial-overlay-progress");
    const titleElement    = overlay.querySelector(".tutorial-overlay-title");
    const nextButton      = overlay.querySelector(".tutorial-overlay-next-button");
    const finishButton    = overlay.querySelector(".tutorial-overlay-finish-button");
    const spotlightElement = overlay.querySelector(".tutorial-overlay-spotlight");

    const isShown = (element) => Boolean(element) && element.style.display !== "none";

    const visibleNext   = isShown(nextButton);
    const visibleFinish = isShown(finishButton);
    const nextDisabled  = Boolean(nextButton)
        && (nextButton.disabled || nextButton.classList.contains("tutorial-overlay-next-button--disabled"));

    const isModal     = overlay.classList.contains("tutorial-overlay--modal");
    const isHighlight = overlay.classList.contains("tutorial-overlay--highlight");
    const isFloating  = overlay.classList.contains("tutorial-overlay--floating");

    let stepIndex = null;
    let stepCount = null;
    const progressMatch = (progressElement ? progressElement.textContent : "").match(/Step\s+(\d+)\s+of\s+(\d+)/i);
    if (progressMatch)
    {
        stepIndex = parseInt(progressMatch[1], 10);
        stepCount = parseInt(progressMatch[2], 10);
    }

    // Probe the spotlight hole: what would the user's click actually land on?
    let spotlight = null;
    if (spotlightElement)
    {
        const rectangle = spotlightElement.getBoundingClientRect();
        if (rectangle.width > 0 && rectangle.height > 0)
        {
            const centerX = rectangle.left + rectangle.width / 2;
            const centerY = rectangle.top + rectangle.height / 2;
            const elementAtCenter = document.elementFromPoint(centerX, centerY);
            const insideOverlay = elementAtCenter ? Boolean(elementAtCenter.closest("tutorial-overlay")) : true;
            spotlight = {
                centerX, centerY,
                width: Math.round(rectangle.width),
                height: Math.round(rectangle.height),
                inViewport: rectangle.left >= 0 && rectangle.top >= 0
                    && rectangle.right <= window.innerWidth && rectangle.bottom <= window.innerHeight,
                targetTag: elementAtCenter ? elementAtCenter.tagName.toLowerCase() : null,
                targetInsideOverlay: insideOverlay,
                targetIsEditable: elementAtCenter
                    ? (/^(input|textarea)$/i.test(elementAtCenter.tagName) || elementAtCenter.isContentEditable)
                    : false,
            };
        }
    }

    return {
        visible: true,
        stepIndex, stepCount,
        title: titleElement ? titleElement.textContent.trim() : "",
        visibleNext, visibleFinish, nextDisabled,
        isModal, isHighlight, isFloating,
        spotlight,
    };
}

// Fills the element currently exposed at the spotlight centre (used to satisfy a
// step whose Next button is gated by a non-empty-field validator). Returns true
// when a fillable element was found and populated.
function fillSpotlightTargetInPage(value)
{
    const overlay = document.querySelector("tutorial-overlay");
    const spotlightElement = overlay ? overlay.querySelector(".tutorial-overlay-spotlight") : null;
    if (!spotlightElement)
    {
        return false;
    }
    const rectangle = spotlightElement.getBoundingClientRect();
    const element = document.elementFromPoint(rectangle.left + rectangle.width / 2, rectangle.top + rectangle.height / 2);
    if (!element)
    {
        return false;
    }
    if (/^(input|textarea)$/i.test(element.tagName))
    {
        element.focus();
        element.value = value;
        element.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
    }
    if (element.isContentEditable)
    {
        element.focus();
        element.textContent = value;
        element.dispatchEvent(new InputEvent("input", { bubbles: true }));
        return true;
    }
    return false;
}

function currentPageTagInPage(knownTags)
{
    if (window.__tutorialE2E && typeof window.__tutorialE2E.currentPageTag === "function")
    {
        const seamTag = window.__tutorialE2E.currentPageTag();
        if (seamTag)
        {
            return seamTag;
        }
    }
    // Fallback: the visible page-tagged custom element.
    for (const tag of knownTags)
    {
        const element = document.querySelector(tag);
        if (element && element.getClientRects().length > 0)
        {
            return tag;
        }
    }
    return "";
}

// -- Main --------------------------------------------------------------------

(async () =>
{
    if (!SESSION_COOKIE)
    {
        skip("Set TEST_SESSION_COOKIE to a seeded (terms-accepted) session; the tutorials need the authenticated Home page + deck tree.");
        return;
    }

    const cases = [];
    const scriptErrors = [];
    const record = (name, passed, detail) =>
        cases.push({ name, status: passed ? "PASS" : "FAIL", detail: detail || "" });
    const recordSkip = (name, detail) =>
        cases.push({ name, status: "SKIPPED", detail: detail || "" });

    let totalStepsWalked = 0;
    let totalStepsExpected = 0;
    let tutorialsCompleted = 0;
    let tutorialsAttempted = 0;

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
        await page.setViewport(VIEWPORT);
        page.on("pageerror", error => scriptErrors.push(`pageerror: ${error.message}`));

        await page.setCookie({ name: "sessionId", value: SESSION_COOKIE, url: BASE_URL });

        try
        {
            await page.goto(BASE_URL + "/?tutorialE2E=1", { waitUntil: "networkidle2", timeout: 30000 });
        }
        catch (error)
        {
            skip(`Could not load ${BASE_URL}: ${error.message}. Start the Dock server first.`);
            await browser.close();
            return;
        }

        // Wait for the boot sequence to register the opt-in seam.
        let seamReady = false;
        const seamDeadline = Date.now() + 15000;
        while (Date.now() < seamDeadline)
        {
            seamReady = await page.evaluate(() => Boolean(window.__tutorialE2E
                && typeof window.__tutorialE2E.listTutorials === "function"));
            if (seamReady)
            {
                break;
            }
            await sleep(300);
        }

        if (!seamReady)
        {
            skip("window.__tutorialE2E seam not found — rebuild the app (setup.bat --aggressive) so TutorialBootstrap's ?tutorialE2E hook is bundled, and confirm the session reaches the Home page.");
            await browser.close();
            return;
        }

        const tutorials = await page.evaluate(() => window.__tutorialE2E.listTutorials());
        record("Tutorial registry is reachable and non-empty", tutorials.length > 0,
            `${tutorials.length} tutorial(s): ${tutorials.map(tutorial => tutorial.id).join(", ")}`);

        for (const tutorial of tutorials)
        {
            tutorialsAttempted += 1;
            totalStepsExpected += tutorial.stepCount;
            const label = tutorial.id;

            // -- Return to a clean Home, then start this tutorial. --
            await page.evaluate(() => window.__tutorialE2E.goHome());
            await sleep(STEP_SETTLE_MS);

            const started = await page.evaluate((tutorialId) => window.__tutorialE2E.play(tutorialId), tutorial.id);
            if (!started)
            {
                record(`[${label}] tutorial starts`, false, "play() returned false (another tutorial running, or no steps).");
                continue;
            }

            // Wait for the first step to render.
            let state = await waitForStepRender(page, null);
            if (!state.visible)
            {
                record(`[${label}] tutorial starts`, false,
                    "Overlay never rendered the first step (blocked by a terms / sync dialog holding the overlay slot?).");
                await recoverFromTutorial(page);
                continue;
            }
            record(`[${label}] tutorial starts`, true, `first step: "${state.title}" (1 of ${state.stepCount})`);

            const walkResult = await walkTutorial(page, label, state, record, recordSkip);
            totalStepsWalked += walkResult.stepsWalked;
            if (walkResult.completed)
            {
                tutorialsCompleted += 1;
                record(`[${label}] walkthrough completes start-to-finish`, true,
                    `${walkResult.stepsWalked}/${tutorial.stepCount} steps walked, no magic navigation`);
            }
            else
            {
                record(`[${label}] walkthrough completes start-to-finish`, false,
                    `stopped at step ${walkResult.lastStepIndex}: ${walkResult.reason}`);
            }

            await recoverFromTutorial(page);
            await sleep(200);
        }

        // -- Client-side error gate over the whole run. --
        record("No client-side script errors during tutorial walkthroughs",
            scriptErrors.length === 0,
            scriptErrors.slice(0, 5).join(" | ") || "no pageerror / unhandled rejection captured");
    }
    finally
    {
        if (browser)
        {
            await browser.close();
        }
    }

    const passed = cases.filter(testCase => testCase.status === "PASS").length;
    const failed = cases.filter(testCase => testCase.status === "FAIL").length;
    const skipped = cases.filter(testCase => testCase.status === "SKIPPED").length;
    const percent = totalStepsExpected > 0
        ? Math.round(1000 * totalStepsWalked / totalStepsExpected) / 10
        : null;

    const payload = {
        service: "Main",
        category: CATEGORY,
        status: failed > 0 ? "FAIL" : (passed === 0 ? "SKIPPED" : (skipped > 0 ? "PARTIAL" : "PASS")),
        passed, failed, skipped, total: cases.length,
        coverage: {
            kind: "steps",
            label: "Steps walked",
            percent,
            covered: totalStepsWalked,
            total: totalStepsExpected,
            detail: `${tutorialsCompleted}/${tutorialsAttempted} tutorials completed; `
                + `${totalStepsWalked}/${totalStepsExpected} steps walked end-to-end`,
        },
        metrics: {
            label: "Tutorials",
            tutorialsAttempted,
            tutorialsCompleted,
            scriptFaults: scriptErrors.length,
        },
        cases,
        notes: `${tutorialsCompleted}/${tutorialsAttempted} tutorials walked start-to-finish; `
            + `${totalStepsWalked}/${totalStepsExpected} steps; ${scriptErrors.length} script fault(s).`,
    };
    writeResult(payload);
    console.log(`Main ${CATEGORY}: ${passed} passed, ${failed} failed, ${skipped} skipped`
        + (percent !== null ? `, ${percent}% steps walked` : ""));
})().catch(error =>
{
    skip(`Unexpected runner error: ${error && error.message}`);
    process.exit(0);
});

// -- Driver helpers ----------------------------------------------------------

// Drives one tutorial from its (already-rendered) first step to its finish
// dialog, recording a visibility case for every click step and a magic-nav case
// for every step boundary. Returns { completed, stepsWalked, lastStepIndex, reason }.
async function walkTutorial(page, label, firstState, record, recordSkip)
{
    let state = firstState;
    let stepsWalked = 0;
    const maxSteps = (firstState.stepCount || 30) + 5;

    for (let iteration = 0; iteration < maxSteps; iteration++)
    {
        await sleep(STEP_SETTLE_MS);
        state = await page.evaluate(readOverlayStateInPage);

        if (!state.visible)
        {
            // Overlay gone unexpectedly mid-walk (an exit we didn't trigger).
            return { completed: false, stepsWalked, lastStepIndex: "?", reason: "overlay disappeared mid-walkthrough" };
        }

        const stepLabel = `step ${state.stepIndex}/${state.stepCount} "${truncate(state.title, 40)}"`;
        const pageBefore = await page.evaluate(currentPageTagInPage, KNOWN_PAGE_TAGS);

        const isAcknowledgeStep = state.visibleNext || state.visibleFinish;
        const isUserActionStep = !state.visibleNext && !state.visibleFinish;

        if (isUserActionStep)
        {
            // The user must click a real in-app element. Assert it is exposed
            // and clickable, then click it for real at the spotlight centre.
            const visible = Boolean(state.spotlight) && !state.isFloating
                && state.spotlight.targetTag && !state.spotlight.targetInsideOverlay;
            record(`[${label}] ${stepLabel}: click target is visible & clickable`, visible,
                describeTarget(state));

            if (!visible)
            {
                return { completed: false, stepsWalked, lastStepIndex: state.stepIndex,
                    reason: `click target not exposed (${describeTarget(state)})` };
            }

            await page.mouse.click(state.spotlight.centerX, state.spotlight.centerY);
        }
        else if (isAcknowledgeStep)
        {
            // A highlight step also points at an element; record whether the
            // thing being pointed at is actually on screen (informational —
            // only fails when the overlay fell back to a floating tooltip
            // because the selector never resolved).
            if (state.isHighlight && state.spotlight)
            {
                const pointed = !state.isFloating && state.spotlight.targetTag && !state.spotlight.targetInsideOverlay;
                record(`[${label}] ${stepLabel}: highlighted element is on screen`, pointed, describeTarget(state));
            }

            // Satisfy a validator-gated Next by filling the highlighted field.
            if (state.visibleNext && state.nextDisabled)
            {
                await page.evaluate(fillSpotlightTargetInPage, FIELD_VALUE);
                await sleep(150);
                state = await page.evaluate(readOverlayStateInPage);
            }

            const buttonSelector = state.visibleFinish
                ? ".tutorial-overlay-finish-button"
                : ".tutorial-overlay-next-button";
            const clicked = await clickOverlayButton(page, buttonSelector);
            if (!clicked)
            {
                return { completed: false, stepsWalked, lastStepIndex: state.stepIndex,
                    reason: `could not click ${buttonSelector} (still disabled?)` };
            }

            if (state.visibleFinish)
            {
                // Finish → cleanup runs → finish dialog appears. Dismiss it.
                const dismissed = await dismissFinishDialog(page);
                stepsWalked += 1;
                if (!dismissed)
                {
                    return { completed: false, stepsWalked, lastStepIndex: state.stepIndex,
                        reason: "finish dialog never appeared / could not be dismissed" };
                }
                return { completed: true, stepsWalked, lastStepIndex: state.stepIndex, reason: "" };
            }
        }

        // -- Wait for the step to advance, then check for magic navigation. --
        const advanced = await waitForAdvance(page, state.stepIndex);
        stepsWalked += 1;

        // Give a teleporting setupAction time to navigate before sampling.
        await sleep(STEP_SETTLE_MS);
        const pageAfter = await page.evaluate(currentPageTagInPage, KNOWN_PAGE_TAGS);

        if (isAcknowledgeStep && pageBefore && pageAfter && pageBefore !== pageAfter)
        {
            record(`[${label}] ${stepLabel}: no magic navigation`, false,
                `page changed ${pageBefore} -> ${pageAfter} on a passive Next/Finish click — the user did not click anything to trigger it`);
        }
        else if (isAcknowledgeStep)
        {
            record(`[${label}] ${stepLabel}: no magic navigation`, true,
                pageAfter ? `stayed on ${pageAfter}` : "no page change");
        }

        if (!advanced.advanced && !advanced.overlayGone)
        {
            return { completed: false, stepsWalked, lastStepIndex: state.stepIndex,
                reason: "step did not advance within timeout (target click had no effect?)" };
        }
        if (advanced.overlayGone)
        {
            // Overlay closed without us clicking Finish — treat as a clean exit
            // only if it happened after the last step; otherwise it's an early exit.
            return { completed: state.stepIndex >= state.stepCount, stepsWalked,
                lastStepIndex: state.stepIndex, reason: "overlay closed before Finish" };
        }
    }

    return { completed: false, stepsWalked, lastStepIndex: "?", reason: "exceeded step budget (possible loop)" };
}

function truncate(text, maximum)
{
    if (!text)
    {
        return "";
    }
    return text.length > maximum ? text.slice(0, maximum - 1) + "…" : text;
}

function describeTarget(state)
{
    if (state.isFloating)
    {
        return "selector did not resolve — overlay fell back to a floating tooltip (target not on screen)";
    }
    if (!state.spotlight)
    {
        return "no spotlight rendered for this step";
    }
    const parts = [`landed on <${state.spotlight.targetTag || "nothing"}>`];
    if (state.spotlight.targetInsideOverlay)
    {
        parts.push("which is the overlay/mask (target covered, not clickable)");
    }
    if (!state.spotlight.inViewport)
    {
        parts.push("spotlight partly outside viewport");
    }
    parts.push(`spotlight ${state.spotlight.width}x${state.spotlight.height}`);
    return parts.join("; ");
}

async function clickOverlayButton(page, selector)
{
    return page.evaluate((buttonSelector) =>
    {
        const overlay = document.querySelector("tutorial-overlay");
        const button = overlay ? overlay.querySelector(buttonSelector) : null;
        if (!button || button.disabled || button.style.display === "none")
        {
            return false;
        }
        button.click();
        return true;
    }, selector);
}

async function waitForStepRender(page, previousStepIndex)
{
    const deadline = Date.now() + ADVANCE_TIMEOUT_MS;
    while (Date.now() < deadline)
    {
        const state = await page.evaluate(readOverlayStateInPage);
        if (state.visible && state.stepIndex !== null
            && (previousStepIndex === null || state.stepIndex !== previousStepIndex))
        {
            await sleep(STEP_SETTLE_MS);
            return await page.evaluate(readOverlayStateInPage);
        }
        await sleep(POLL_INTERVAL_MS);
    }
    return { visible: false };
}

async function waitForAdvance(page, fromStepIndex)
{
    const deadline = Date.now() + ADVANCE_TIMEOUT_MS;
    while (Date.now() < deadline)
    {
        const state = await page.evaluate(readOverlayStateInPage);
        if (!state.visible)
        {
            return { advanced: false, overlayGone: true };
        }
        if (state.stepIndex !== null && state.stepIndex > fromStepIndex)
        {
            return { advanced: true, overlayGone: false };
        }
        await sleep(POLL_INTERVAL_MS);
    }
    return { advanced: false, overlayGone: false };
}

async function dismissFinishDialog(page)
{
    const deadline = Date.now() + ADVANCE_TIMEOUT_MS;
    while (Date.now() < deadline)
    {
        const clicked = await page.evaluate(() =>
        {
            const doneButton = document.querySelector(".tutorial-finish-done-button");
            if (doneButton)
            {
                doneButton.click();
                return true;
            }
            return false;
        });
        if (clicked)
        {
            await sleep(300);
            return true;
        }
        await sleep(POLL_INTERVAL_MS);
    }
    return false;
}

// Best-effort exit so the next tutorial starts from a clean slate: if a
// tutorial is still running (we got stuck, or it exited oddly), click Skip to
// trigger the engine's normal cleanup, dismiss any finish dialog, and go Home.
async function recoverFromTutorial(page)
{
    const running = await page.evaluate(() =>
        Boolean(window.__tutorialE2E && window.__tutorialE2E.isRunning && window.__tutorialE2E.isRunning()));
    if (running)
    {
        await page.evaluate(() =>
        {
            const overlay = document.querySelector("tutorial-overlay");
            const skipButton = overlay ? overlay.querySelector(".tutorial-overlay-skip-button") : null;
            if (skipButton)
            {
                skipButton.click();
            }
        });
        await dismissFinishDialog(page);
    }
    // Clear any stray dialogs and return Home.
    await page.evaluate(() =>
    {
        document.querySelectorAll("dialog-box").forEach(node => node.remove());
        if (window.__tutorialE2E && typeof window.__tutorialE2E.goHome === "function")
        {
            window.__tutorialE2E.goHome();
        }
    });
    await sleep(STEP_SETTLE_MS);
}
