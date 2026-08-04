// Browser UI tests for CogniumLearn's CRITICAL USER FLOWS, driven by a real
// Chromium via Puppeteer against the BUILT app (Dock/Static).
//
// Where run_tutorial_ui_tests.js proves the guided tours still walk, this suite
// proves the everyday operations a user performs by hand still work: creating
// and organising decks, authoring and editing cards and study materials,
// browsing and searching them, running every study mode (reveal, rate,
// navigate, mark for review, revise, content study), and — critically — that
// what they created is still there after a reload.
//
// 25 cases, run IN ORDER against one throwaway fixture deck the suite creates
// and deletes itself. They are deliberately sequential: each builds the state
// the next one needs, which is also how a real user experiences the app. A case
// that fails is recorded and the run continues; cases whose precondition never
// materialised are recorded as FAILED with the reason, never silently skipped.
//
// Everything is exercised through the real rendered DOM — real clicks, real
// typed keystrokes. Nothing reaches into app internals.
//
//   node Common/Testing/Main/run_critical_flow_tests.js
//
// Env: BASE_URL (default http://127.0.0.1:3000),
//      TEST_SESSION_COOKIE (REQUIRED — a valid sessionId for a seeded account
//      that has already accepted the Terms; without it the home page / deck
//      tree never load and the whole suite is SKIPPED, never FAILED),
//      HEADFUL=1 to watch it in a visible Chromium window (SLOW_MO_MS paces it),
//      VERBOSE=1 to print a per-case trace as the run proceeds.
// Result JSON -> $RESULT_FILE or Common/Reports/.results/critical-flow-ui.json.

const fs = require("fs");
const path = require("path");

// The two credit cases read the ledger straight from MongoDB — credit charging
// leaves no trace in the UI, so a database read is the only trustworthy check.
const CreditLedgerProbe = require("./CreditLedgerProbe");

const REPOSITORY_ROOT = path.resolve(__dirname, "..", "..", "..");
const RESULT_FILE = process.env.RESULT_FILE
    || path.join(REPOSITORY_ROOT, "Common", "Reports", ".results", "critical-flow-ui.json");
const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:3000";
const SESSION_COOKIE = process.env.TEST_SESSION_COOKIE || "";
// Must be the session's own user, or the credit cases measure the wrong balance.
const TEST_ACCOUNT_ID = process.env.TEST_ACCOUNT_ID || "browser-suite-test-user";

// Ask AI streams from a spawned worker, so first-token latency includes the
// worker's start-up; the charge then settles a beat after the stream closes.
const ASK_AI_STREAM_TIMEOUT_MS = 120000;
const ASK_AI_LEDGER_SETTLE_TIMEOUT_MS = 45000;
const CATEGORY = "Critical User Flows (Puppeteer)";
const RUN_HEADFUL = process.env.HEADFUL === "1";
const SLOW_MO_MS = Number(process.env.SLOW_MO_MS || 0) || 0;
const VERBOSE = process.env.VERBOSE === "1";

const VIEWPORT = { width: 1280, height: 900 };
const DEFAULT_WAIT_MS = 12000;
const POLL_INTERVAL_MS = 120;
const SETTLE_MS = 350;

// Every fixture this run creates carries this prefix so a previous run that
// died mid-way can be swept up before the new one starts.
const FIXTURE_PREFIX = "ZZTest";
const RUN_TAG = String(Date.now()).slice(-6);
const FIXTURE_DECK_NAME = `${FIXTURE_PREFIX} Deck ${RUN_TAG}`;
const FIXTURE_DECK_SHORT_NAME = `${FIXTURE_PREFIX}${RUN_TAG}`;
const FIXTURE_DECK_RENAMED = `${FIXTURE_PREFIX} Renamed ${RUN_TAG}`;
const FIXTURE_SUB_DECK_NAME = `${FIXTURE_PREFIX} Sub ${RUN_TAG}`;
const FIXTURE_SUB_DECK_SHORT_NAME = `Sub${RUN_TAG}`;

const CARD_ONE_QUESTION = "Which phase of the lifecycle is Spaced Repetition for?";
const CARD_ONE_ANSWER   = "The Encode phase.";
const CARD_TWO_QUESTION = "Which phase do Mock Tests belong to?";
const CARD_TWO_ANSWER   = "The Validate phase.";
const CARD_TWO_QUESTION_SUFFIX = " (edited)";
const STUDY_MATERIAL_TEXT = "The five phases are Acquire, Encode, Consolidate, Validate and Reflect.";

const sleep = (milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds));

function trace(message)
{
    if (VERBOSE)
    {
        console.log(message);
    }
}

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
        coverage: { kind: "flows", label: "Flows exercised", percent: null, detail: note },
        cases: [], notes: note,
    });
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

// -- Page-context probes ------------------------------------------------------

// Every page custom-element tag the app can mount. Needed because not every
// page sets the `page` attribute on itself (study-page and deck-insights-page
// do not), so an attribute scan alone silently reports "no page".
const KNOWN_PAGE_TAGS = [
    "home-page", "login-page", "admin-panel-page", "settings-page",
    "cogniumlearn-about-page", "tutorials-page", "progress-page", "study-page",
    "card-editor-page", "study-material-editor-page", "deck-editor-page",
    "mock-test-editor-page", "mock-test-answer-key-page", "browser-page",
    "deck-insights-page", "automatic-generation-page", "activity-page",
    "paid-deck-library-page", "paid-deck-details-page", "paid-deck-browse-page",
];

// The tag of the page the user is actually looking at. PageNavigator's own
// accessor is authoritative when the opt-in seam is present; otherwise fall
// back to the topmost VISIBLE page element (PageNavigator hides the pages it
// has stacked underneath).
function visiblePageTagInPage(knownTags)
{
    if (window.__tutorialE2E && typeof window.__tutorialE2E.currentPageTag === "function")
    {
        const seamTag = window.__tutorialE2E.currentPageTag();
        if (seamTag)
        {
            return seamTag;
        }
    }

    const attributedPages = Array.from(document.querySelectorAll("[page]"))
        .filter(element => element.getClientRects().length > 0);
    if (attributedPages.length > 0)
    {
        return attributedPages[attributedPages.length - 1].tagName.toLowerCase();
    }

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

// Resolves a selector the way a user's eye would: the first match that is
// actually rendered. Several pages are mounted at once and controls have
// hidden namesakes on the pages underneath.
function visibleMatchExistsInPage(selector)
{
    return Array.from(document.querySelectorAll(selector)).some(element => element.getClientRects().length > 0);
}

function visibleTextInPage(selector)
{
    const element = Array.from(document.querySelectorAll(selector))
        .find(candidate => candidate.getClientRects().length > 0);
    return element ? (element.textContent || "").trim() : "";
}

// The deck-tile custom element for a deck, located by the short name printed on
// the tile. Returns a stable selector keyed on the tile's data-deck-id.
function deckTileSelectorInPage(shortName)
{
    const tiles = Array.from(document.querySelectorAll("deck-tile"))
        .filter(tile => tile.getClientRects().length > 0);
    const match = tiles.find(tile =>
    {
        const nameElement = tile.querySelector(".deck-name-container");
        return nameElement && nameElement.textContent.trim() === shortName;
    });
    return match ? `deck-tile[data-deck-id="${match.getAttribute("data-deck-id")}"]` : "";
}

function dialogTextInPage()
{
    const dialogs = Array.from(document.querySelectorAll("dialog-box"))
        .filter(element => element.getClientRects().length > 0);
    return dialogs.map(element => (element.textContent || "").trim()).join(" | ");
}

// -- Driver helpers -----------------------------------------------------------

async function waitUntil(page, pageFunction, argument, description, timeoutMilliseconds = DEFAULT_WAIT_MS)
{
    const deadline = Date.now() + timeoutMilliseconds;
    let lastValue;
    while (Date.now() < deadline)
    {
        lastValue = await page.evaluate(pageFunction, argument);
        if (lastValue)
        {
            return lastValue;
        }
        await sleep(POLL_INTERVAL_MS);
    }
    throw new Error(`Timed out waiting for ${description} (last value: ${JSON.stringify(lastValue)})`);
}

async function waitForVisible(page, selector, description = null)
{
    await waitUntil(page, visibleMatchExistsInPage, selector, description || `visible ${selector}`);
    await sleep(SETTLE_MS);
}

async function waitForPage(page, pageTagName)
{
    const deadline = Date.now() + DEFAULT_WAIT_MS;
    let current = "";
    while (Date.now() < deadline)
    {
        current = await currentPageTag(page);
        if (current === pageTagName)
        {
            await sleep(SETTLE_MS);
            return;
        }
        await sleep(POLL_INTERVAL_MS);
    }
    throw new Error(`Timed out waiting for the ${pageTagName} to be on screen (currently on <${current || "nothing"}>)`);
}

// Clicks the first VISIBLE match, using a real mouse click at its centre so the
// app sees the same event sequence a user produces.
// True while the non-dismissible sync modal is covering the app. Nothing
// underneath it can be clicked, by the suite or by a user.
// True while ANY sync overlay is covering the app. Detection is structural, by
// component, not by prose.
//
// There are two independent components, and the original text match caught
// neither reliably: <sync-blocking-overlay> (raised when a pull touches the
// entity being edited) is not a dialog-box at all, so it was invisible to this
// check, and SyncBlockingDialog's wording varies by caller, so a reworded body
// slipped through too. Both absorb coordinate clicks, which is how a swallowed
// click became "the app ignored the button" two steps later.
async function syncModalIsUp(page)
{
    return page.evaluate(() =>
    {
        const isOnScreen = element => element.getClientRects().length > 0;

        // The full-screen overlay component (hidden via display:none, so it has
        // no client rects when idle).
        if (Array.from(document.querySelectorAll("sync-blocking-overlay")).some(isOnScreen))
        {
            return true;
        }

        // SyncBlockingDialog's own markup, matched by class rather than copy.
        if (Array.from(document.querySelectorAll(".sync-blocking-overlay-backdrop, .sync-blocking-content, .sync-blocking-body")).some(isOnScreen))
        {
            return true;
        }

        // Retained as a backstop for any sync modal that predates those markers.
        return Array.from(document.querySelectorAll("dialog-box"))
            .filter(isOnScreen)
            .some(element => /sync state|getting everything back in sync/i.test(element.textContent || ""));
    }).catch(() => false);
}

async function clickVisible(page, selector)
{
    // Two overlays can cover the target at any moment, and both absorb a
    // coordinate click: the sync-blocking overlay (a write from an earlier step
    // lands and its pull touches what is being edited) and a badge celebration
    // (a streak or milestone badge is earned mid-case). Both are waited out /
    // dismissed inside the aiming loop below, which re-checks per attempt —
    // exactly what a user does when something covers the button they wanted.

    // Wait for the target to stop moving before aiming at it. Dialogs scale in
    // over ~200ms, and their buttons are small — a point measured mid-animation
    // can miss by more than the button is wide, so the click silently lands on
    // the dialog body and the flow stalls a step later.
    const readCentre = () => page.evaluate((targetSelector) =>
    {
        const element = Array.from(document.querySelectorAll(targetSelector))
            .find(candidate => candidate.getClientRects().length > 0);
        if (!element)
        {
            return null;
        }
        element.scrollIntoView({ block: "center", inline: "center", behavior: "auto" });
        const rectangle = element.getBoundingClientRect();
        const centreX = rectangle.left + rectangle.width / 2;
        const centreY = rectangle.top + rectangle.height / 2;

        // Hit-test the exact point we are about to click. A coordinate click
        // goes to whatever owns that pixel, so if something else does, the
        // click is silently absorbed and the flow fails a step or two later
        // with no trace of the real cause.
        const elementAtCentre = document.elementFromPoint(centreX, centreY);
        const describeElement = (candidate) =>
        {
            if (!candidate)
            {
                return "(nothing)";
            }
            const classText = typeof candidate.className === "string" && candidate.className.trim().length > 0
                ? "." + candidate.className.trim().split(/\s+/).join(".")
                : "";
            return candidate.tagName.toLowerCase() + classText;
        };

        return {
            x: centreX,
            y: centreY,
            key: `${Math.round(rectangle.left)}:${Math.round(rectangle.top)}:${Math.round(rectangle.width)}:${Math.round(rectangle.height)}`,
            ownsItsCentre: elementAtCentre === element || element.contains(elementAtCentre),
            elementAtCentre: describeElement(elementAtCentre),
            insideViewport: centreX >= 0 && centreX <= window.innerWidth && centreY >= 0 && centreY <= window.innerHeight
        };
    }, selector);

    const readStabilisedCentre = async () =>
    {
        let candidatePoint = await readCentre();
        for (let attempt = 0; attempt < 20; attempt++)
        {
            await sleep(60);
            const next = await readCentre();
            if (next && candidatePoint && next.key === candidatePoint.key)
            {
                return next;
            }
            candidatePoint = next;
        }
        return candidatePoint;
    };

    // Re-aim until the target actually owns the pixel we are about to click.
    //
    // Checking for a blocking overlay ONCE at the top of this function loses the
    // race: a write from the previous step lands mid-aim, the sync overlay goes
    // up between that check and this measurement, and the click is absorbed by
    // its backdrop. The failure then surfaces steps later as "the app ignored
    // the button". Verifying ownership at the moment of aiming — and waiting the
    // overlay out before re-measuring — closes the race instead of narrowing it.
    let point = null;
    const aimDeadline = Date.now() + 90000;

    while (Date.now() < aimDeadline)
    {
        while (Date.now() < aimDeadline && await syncModalIsUp(page))
        {
            await sleep(1000);
        }
        await dismissBadgeCelebrationIfPresent(page);
        await waitForVisible(page, selector);

        point = await readStabilisedCentre();
        if (!point)
        {
            throw new Error(`No visible element to click for ${selector}`);
        }

        if (point.ownsItsCentre && point.insideViewport)
        {
            break;
        }

        trace(`    (re-aiming at ${selector}: centre owned by ${point.elementAtCentre}`
            + `${point.insideViewport ? "" : ", point OUTSIDE the viewport"})`);
        await sleep(500);
    }

    // Still obstructed after the deadline: click anyway so the case fails on its
    // own assertion, but say plainly what absorbed the click.
    if (!point.ownsItsCentre || !point.insideViewport)
    {
        trace(`    (WARNING aiming at ${selector}: centre is owned by ${point.elementAtCentre}`
            + `${point.insideViewport ? "" : ", and the point is OUTSIDE the viewport"} — the click may be absorbed)`);
    }

    await page.mouse.click(point.x, point.y);
    await sleep(SETTLE_MS);
}

// Types into a plain <input>. Editors commit their value on `change`, which
// only fires when focus leaves — the same thing that happens when a user moves
// on to the next field — so the blur is part of the flow, not a workaround.
async function typeIntoInput(page, selector, text)
{
    await clickVisible(page, selector);

    // Clear with real keystrokes. Assigning .value fires no `input` event, so
    // any live-filtering the field drives (Browse's search) would never see the
    // field being emptied.
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyA");
    await page.keyboard.up("Control");
    await page.keyboard.press("Backspace");

    if (text.length > 0)
    {
        await page.keyboard.type(text, { delay: 8 });
    }

    await page.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur());
    await sleep(SETTLE_MS);
}

// Types into a <rich-text-editor>. The content lives in an inner
// [contenteditable]; the host also contains toolbar and help text, so the
// editable surface has to be targeted explicitly.
async function typeIntoRichTextEditor(page, hostSelector, text)
{
    await waitForVisible(page, hostSelector);
    const point = await page.evaluate((selector) =>
    {
        const host = Array.from(document.querySelectorAll(selector))
            .find(candidate => candidate.getClientRects().length > 0);
        const editable = host ? host.querySelector("[contenteditable]") : null;
        if (!editable)
        {
            return null;
        }
        editable.scrollIntoView({ block: "center", behavior: "auto" });
        const rectangle = editable.getBoundingClientRect();
        return { x: rectangle.left + rectangle.width / 2, y: rectangle.top + rectangle.height / 2 };
    }, hostSelector);

    if (!point)
    {
        throw new Error(`No editable surface inside ${hostSelector}`);
    }

    await page.mouse.click(point.x, point.y);
    await page.keyboard.type(text, { delay: 8 });
    await sleep(SETTLE_MS);
}

// Waits until no dialog is on screen. Clicking a control the instant after a
// dialog's OK is pressed lands on the backdrop that is still being torn down —
// the click is swallowed and the flow silently stalls a step later.
async function waitForNoVisibleDialog(page)
{
    await waitUntil(page, () =>
    {
        const dialogs = Array.from(document.querySelectorAll("dialog-box"))
            .filter(element => element.getClientRects().length > 0);
        const backdrops = Array.from(document.querySelectorAll(".dialog-backdrop"))
            .filter(element => element.getClientRects().length > 0);
        return (dialogs.length === 0 && backdrops.length === 0) ? "clear" : null;
    }, null, "every dialog to close");
    await sleep(SETTLE_MS);
}

// Reads the text of a VALIDATION dialog, ignoring the sync-blocking modal —
// that one can be on screen for unrelated reasons and would otherwise be
// mistaken for the app's answer to the action under test.
async function waitForValidationDialogText(page, description)
{
    // The sync modal can be raised between the click and the app's response;
    // wait it out so the validation dialog underneath becomes readable.
    const modalDeadline = Date.now() + 60000;
    while (Date.now() < modalDeadline && await syncModalIsUp(page))
    {
        await sleep(1000);
    }

    return waitUntil(page, () =>
    {
        const text = Array.from(document.querySelectorAll("dialog-box"))
            .filter(element => element.getClientRects().length > 0)
            .map(element => (element.textContent || "").trim())
            .filter(candidate => !/sync state|getting everything back in sync/i.test(candidate))
            .join(" ");
        return text.length > 0 ? text : null;
    }, null, description);
}

// Answers a dialog through its OK button (alerts and confirms share it) and
// waits for it to actually go away. Retried because a dialog appended in the
// same frame the click is dispatched can miss the event; the button itself is
// fine — a second press always lands.
async function dismissAlert(page)
{
    for (let attempt = 1; attempt <= 3; attempt++)
    {
        await clickVisible(page, "dialog-box .ok-button");

        const closed = await page.evaluate(() =>
        {
            const dialogs = Array.from(document.querySelectorAll("dialog-box"))
                .filter(element => element.getClientRects().length > 0);
            return dialogs.length === 0;
        });

        if (closed)
        {
            await waitForNoVisibleDialog(page);
            return;
        }

        trace(`    (dialog still open after OK press ${attempt}; retrying)`);
        await sleep(400);
    }

    await waitForNoVisibleDialog(page);
}

// Boot can put up a blocking "Restoring sync state" dialog while the client
// reconciles with the server. It clears itself; the suite must wait it out
// rather than dismiss it, since dismissing would abandon the sync mid-flight.
// Waits for the home footer's sync indicator to stop reporting work in
// progress, so the suite never interrupts a cycle mid-flight.
async function waitForSyncedIndicator(page)
{
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline)
    {
        const label = await page.evaluate(() =>
        {
            const element = Array.from(document.querySelectorAll(".sync-status-label"))
                .find(candidate => candidate.getClientRects().length > 0);
            return element ? element.textContent.trim() : "";
        }).catch(() => "");

        if (label && !/sync(ing)?\b/i.test(label.replace(/^Synced$/i, "")))
        {
            return label;
        }
        if (/^Synced$/i.test(label))
        {
            return label;
        }

        await sleep(1000);
    }
    return "(sync indicator never settled)";
}

async function waitForSyncToSettle(page)
{
    const deadline = Date.now() + 120000;
    // The dialog is raised a beat AFTER the home page mounts, so "not there
    // yet" is not the same as "finished". Require the absence to hold for a
    // few consecutive checks before calling it settled.
    let consecutiveClearChecks = 0;

    while (Date.now() < deadline)
    {
        const blockingText = await page.evaluate(() =>
        {
            const dialog = Array.from(document.querySelectorAll("dialog-box"))
                .filter(element => element.getClientRects().length > 0)
                .map(element => (element.textContent || ""))
                .find(text => /sync state|getting everything back in sync|Preparing/i.test(text));
            return dialog ? dialog.trim().slice(0, 60) : "";
        }).catch(() => "");

        if (blockingText)
        {
            consecutiveClearChecks = 0;

            // A reload that interrupts a sync cycle leaves the server-side lock
            // held until its TTL, and the app offers the user a Force Unlock &
            // Retry button for exactly that. Taking it is the intended recovery,
            // so drive it rather than sitting out the TTL.
            const forceButtonState = await page.evaluate(() =>
            {
                const forceButton = document.querySelector(".sync-blocking-force-button");
                if (!forceButton)
                {
                    return "absent";
                }
                if (forceButton.getClientRects().length === 0)
                {
                    return "hidden";
                }
                if (forceButton.disabled)
                {
                    return "disabled";
                }
                forceButton.click();
                return "pressed";
            }).catch(() => "unavailable");

            trace(`    (sync dialog: "${blockingText.replace(/\s+/g, " ")}" — force button ${forceButtonState})`);
        }
        else
        {
            consecutiveClearChecks += 1;
            if (consecutiveClearChecks >= 4)
            {
                return;
            }
        }

        await sleep(1000);
    }
    throw new Error("The boot sync dialog never cleared within 120s");
}

// Makes sure the study Assistant panel is expanded. It mounts collapsed, and
// blindly clicking the toggle would close an already-open panel — which then
// hides the very control the next assertion reads.
async function ensureAssistantPanelOpen(page)
{
    const alreadyOpen = await page.evaluate(() =>
    {
        const panel = document.querySelector("study-session-bottom-panel");
        return Boolean(panel) && panel.getBoundingClientRect().height > 5;
    });

    if (alreadyOpen)
    {
        return;
    }

    await clickVisible(page, ".assistant-toggle-button");
    await waitForVisible(page, ".bottom-panel-mark-review-toggle");
}

async function currentPageTag(page)
{
    return page.evaluate(visiblePageTagInPage, KNOWN_PAGE_TAGS);
}

async function deckTileSelector(page, shortName)
{
    return page.evaluate(deckTileSelectorInPage, shortName);
}

// Opens a deck's three-dot options menu and waits for the menu to render.
async function openDeckOptionsMenu(page, shortName)
{
    const tileSelector = await deckTileSelector(page, shortName);
    if (!tileSelector)
    {
        throw new Error(`No deck tile on screen with short name "${shortName}"`);
    }
    await clickVisible(page, `${tileSelector} .deck-options-button`);
    await waitForVisible(page, "deck-options-context-menu");
}

async function openStudyModePicker(page, shortName)
{
    const tileSelector = await deckTileSelector(page, shortName);
    if (!tileSelector)
    {
        throw new Error(`No deck tile on screen with short name "${shortName}"`);
    }
    await clickVisible(page, `${tileSelector} .study-button`);
    await waitForVisible(page, ".study-mode-selection-container");
}

async function goBackViaHeader(page)
{
    await clickVisible(page, "header-component .back-button");
    await sleep(SETTLE_MS);
}

// Walks the app back to the Home page the way a user would — repeated header
// back presses — so no case starts from a page a previous failure left behind.
// A tutorial that started anyway (autoplay raced the seam, or a stray click hit
// the sidebar's Tutorial button) would block every subsequent click behind its
// overlay. Dismiss it through its own Skip button so the engine still runs its
// cleanup, then clear the finish dialog.
// The suite drives a real account, so it earns real badges: a streak badge on
// the first login of the day, and milestone badges as cards are studied and mock
// tests taken. Each one raises a modal celebration that covers the app and holds
// the exclusive blocking-overlay slot until dismissed, so a badge earned by one
// case would otherwise fail the next — and returnToHome's generic dialog sweep
// cannot clear it, since its button is .badge-celebration-continue rather than
// the .ok-button / .cancel-button / .close-button it looks for.
//
// Clicking is deliberate (not removing the element): BadgeCelebrationDialog only
// releases the coordinator slot from its own dismiss handlers.
// Captures what was actually on screen when a case failed. Without this the
// only evidence is the timeout message plus the text of one dialog, which is
// enough to guess at a cause and not enough to identify it — every page in the
// stack stays mounted, so a selector can resolve to a stale twin on a page
// underneath, and a coordinate-aimed click can land on something that never
// appears in the failure text at all. Writes a PNG plus a JSON snapshot beside
// the result file.
async function captureFailureDiagnostics(page, caseNumber, failureMessage)
{
    const diagnosticsDirectory = path.join(path.dirname(RESULT_FILE), "failures");
    const fileNameStem = `flow-${String(caseNumber).padStart(2, "0")}`;

    try
    {
        fs.mkdirSync(diagnosticsDirectory, { recursive: true });
        await page.screenshot({ path: path.join(diagnosticsDirectory, `${fileNameStem}.png`), fullPage: false });

        // The selector the wait gave up on, recovered from the message, so the
        // snapshot can report every match and which element owns its centre.
        const selectorMatch = /visible\s+(\S+)/.exec(failureMessage || "");
        const targetSelector = selectorMatch ? selectorMatch[1] : null;

        const snapshot = await page.evaluate((selector) =>
        {
            const describe = (element) =>
            {
                if (!element)
                {
                    return "(null)";
                }
                const classText = typeof element.className === "string" && element.className.trim().length > 0
                    ? "." + element.className.trim().split(/\s+/).join(".")
                    : "";
                return element.tagName.toLowerCase() + classText;
            };

            const mountedPages = Array.from(document.querySelectorAll("[page]")).map(element =>
            {
                const rect = element.getBoundingClientRect();
                return {
                    tag: element.tagName.toLowerCase(),
                    size: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
                    display: getComputedStyle(element).display
                };
            });

            const targets = selector
                ? Array.from(document.querySelectorAll(selector)).map(element =>
                {
                    const rect = element.getBoundingClientRect();
                    const centreX = rect.left + rect.width / 2;
                    const centreY = rect.top + rect.height / 2;
                    const elementAtCentre = document.elementFromPoint(centreX, centreY);
                    return {
                        rect: { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) },
                        visibleByClientRects: element.getClientRects().length > 0,
                        insideViewport: rect.top >= 0 && rect.bottom <= window.innerHeight && rect.left >= 0 && rect.right <= window.innerWidth,
                        ownsItsCentre: elementAtCentre === element || element.contains(elementAtCentre),
                        elementAtCentre: describe(elementAtCentre),
                        ancestor: describe(element.parentElement)
                    };
                })
                : [];

            return {
                selector: selector,
                targetMatchCount: targets.length,
                targets: targets,
                mountedPages: mountedPages,
                visibleDialogs: Array.from(document.querySelectorAll("dialog-box"))
                    .filter(dialog => dialog.getClientRects().length > 0)
                    .map(dialog => ({
                        buttons: Array.from(dialog.querySelectorAll("button")).map(button => describe(button)),
                        text: (dialog.textContent || "").trim().replace(/\s+/g, " ").slice(0, 140)
                    })),
                hiddenDialogCount: Array.from(document.querySelectorAll("dialog-box")).filter(dialog => dialog.getClientRects().length === 0).length,
                badgeCelebrationCount: document.querySelectorAll(".badge-celebration").length,
                viewport: { width: window.innerWidth, height: window.innerHeight },
                scrollY: window.scrollY,
                activeElement: describe(document.activeElement)
            };
        }, targetSelector);

        snapshot.failureMessage = failureMessage;
        fs.writeFileSync(path.join(diagnosticsDirectory, `${fileNameStem}.json`), JSON.stringify(snapshot, null, 2), "utf-8");

        return path.join(diagnosticsDirectory, fileNameStem);
    }
    catch (captureError)
    {
        return `(diagnostics capture failed: ${captureError.message})`;
    }
}

async function dismissBadgeCelebrationIfPresent(page)
{
    const dismissedCount = await page.evaluate(() =>
    {
        const continueButtons = Array.from(document.querySelectorAll(".badge-celebration-continue"))
            .filter(candidate => candidate.getClientRects().length > 0);
        for (const continueButton of continueButtons)
        {
            continueButton.click();
        }
        return continueButtons.length;
    });

    if (dismissedCount === 0)
    {
        return false;
    }

    await sleep(800);
    return true;
}

async function dismissTutorialOverlayIfPresent(page)
{
    const overlayVisible = await page.evaluate(() =>
    {
        const overlay = document.querySelector("tutorial-overlay");
        return Boolean(overlay) && overlay.style.display !== "none";
    });

    if (!overlayVisible)
    {
        return false;
    }

    await page.evaluate(() =>
    {
        const overlay = document.querySelector("tutorial-overlay");
        const skipButton = overlay ? overlay.querySelector(".tutorial-overlay-skip-button") : null;
        if (skipButton)
        {
            skipButton.click();
        }
    });
    await sleep(1200);
    await page.evaluate(() => document.querySelector(".tutorial-finish-done-button")?.click());
    await sleep(800);
    return true;
}

async function returnToHome(page)
{
    for (let attempt = 0; attempt < 8; attempt++)
    {
        await dismissTutorialOverlayIfPresent(page);
        await dismissBadgeCelebrationIfPresent(page);

        // Answer any open dialog through its own button so the app's awaiting
        // promise resolves. Ripping the element out of the DOM leaves the page
        // blocked on a promise that never settles, and the next back press
        // then does nothing.
        const answered = await page.evaluate(() =>
        {
            const dialog = Array.from(document.querySelectorAll("dialog-box"))
                .find(element => element.getClientRects().length > 0);
            if (!dialog)
            {
                return false;
            }
            const button = dialog.querySelector(".cancel-button, .ok-button, .close-button");
            if (button)
            {
                button.click();
                return true;
            }
            dialog.remove();
            return true;
        });

        if (answered)
        {
            await sleep(SETTLE_MS);
            continue;
        }

        await page.evaluate(() =>
        {
            document.querySelectorAll("deck-options-context-menu, home-page-context-menu, card-options-context-menu")
                .forEach(element => element.remove());
            document.querySelectorAll(".dialog-backdrop").forEach(element => element.remove());
        });

        if (await currentPageTag(page) === "home-page")
        {
            await sleep(SETTLE_MS);
            return true;
        }

        const hasBackButton = await page.evaluate(visibleMatchExistsInPage, "header-component .back-button");
        if (!hasBackButton)
        {
            return false;
        }
        await goBackViaHeader(page);
    }
    return await currentPageTag(page) === "home-page";
}

// -- Main ---------------------------------------------------------------------

(async () =>
{
    if (!SESSION_COOKIE)
    {
        skip("Set TEST_SESSION_COOKIE to a seeded (terms-accepted) session; the flows need the authenticated Home page + deck tree.");
        return;
    }

    const cases = [];
    const scriptErrors = [];
    let caseNumber = 0;

    let browser;
    try
    {
        browser = await puppeteer.launch({
            headless: RUN_HEADFUL ? false : "new",
            slowMo: SLOW_MO_MS,
            defaultViewport: VIEWPORT,
            args: ["--no-sandbox", "--disable-setuid-sandbox", `--window-size=${VIEWPORT.width},${VIEWPORT.height + 120}`]
        });
    }
    catch (error)
    {
        skip(`Chromium failed to launch: ${error.message}. Run \`npx puppeteer browsers install chrome\`.`);
        return;
    }

    let page;
    try
    {
        page = await browser.newPage();
        await page.setViewport(VIEWPORT);
        page.on("pageerror", error => scriptErrors.push(`pageerror: ${error.message}`));

        await page.setCookie({ name: "sessionId", value: SESSION_COOKIE, url: BASE_URL });

        try
        {
            // "/index.html?..." rather than "/?..." — the server's route
            // normalisation drops the root path when a query string is present.
            //
            // The ?tutorialE2E flag is here for ONE reason: it marks the
            // tutorials completed so the Beginners tour does not auto-play. A
            // fresh Chromium profile is a first launch as far as the app is
            // concerned, and the tour's overlay would swallow every click in
            // this suite. Walking the tours is run_tutorial_ui_tests.js's job.
            await page.goto(BASE_URL + "/index.html?tutorialE2E=1", { waitUntil: "networkidle2", timeout: 30000 });
        }
        catch (error)
        {
            skip(`Could not load ${BASE_URL}: ${error.message}. Start the Dock server first.`);
            await browser.close();
            return;
        }

        // Give the boot sequence a chance to install the seam (and so to have
        // suppressed autoplay) before the first click.
        const seamDeadline = Date.now() + 20000;
        while (Date.now() < seamDeadline)
        {
            if (await page.evaluate(() => Boolean(window.__tutorialE2E)))
            {
                break;
            }
            await sleep(300);
        }

        // Run a case, record its outcome, and never let one failure abort the
        // rest of the suite. Each case returns a detail string on success.
        // Thrown by a case that cannot run because the ENVIRONMENT is not
        // healthy enough to exercise it (as opposed to the app being wrong).
        // Recorded as SKIPPED with the reason so it is visible, never silently
        // counted as a pass.
        class EnvironmentUnavailableError extends Error {}

        // Set once the environment proves it cannot support the flows at all
        // (the sync backend never settles, leaving a non-dismissible modal over
        // the whole app). Every remaining case is then reported as skipped with
        // that reason instead of producing a cascade of misleading failures.
        let environmentBlockedReason = "";

        const runCase = async (name, caseFunction) =>
        {
            caseNumber += 1;
            const label = `${String(caseNumber).padStart(2, "0")}. ${name}`;

            if (environmentBlockedReason)
            {
                cases.push({ name: label, status: "SKIPPED", detail: environmentBlockedReason });
                trace(`  SKIP ${label} — environment blocked`);
                return;
            }

            try
            {
                // A badge earned by an earlier case celebrates over whatever this
                // case is about to click, so clear it before the case starts.
                await dismissBadgeCelebrationIfPresent(page);

                const detail = await caseFunction();
                cases.push({ name: label, status: "PASS", detail: detail || "" });
                trace(`  PASS ${label}${detail ? " — " + detail : ""}`);
            }
            catch (error)
            {
                if (error instanceof EnvironmentUnavailableError)
                {
                    cases.push({ name: label, status: "SKIPPED", detail: error.message });
                    trace(`  SKIP ${label} — ${error.message}`);
                    await returnToHome(page).catch(() => {});
                    return;
                }

                const pageTag = await currentPageTag(page).catch(() => "?");
                const dialogText = await page.evaluate(dialogTextInPage).catch(() => "");
                // Capture BEFORE returnToHome below, which clears dialogs and
                // navigates — i.e. destroys the state that explains the failure.
                const diagnosticsStem = await captureFailureDiagnostics(page, caseNumber, error.message);
                const detail = `${error.message}${dialogText ? ` | open dialog: "${dialogText}"` : ""} | on <${pageTag}> | diagnostics: ${diagnosticsStem}`;
                cases.push({ name: label, status: "FAIL", detail });
                trace(`  FAIL ${label} — ${detail}`);
                // Get back to a known screen so the next case has a fair chance.
                await returnToHome(page).catch(() => {});
            }
        };

        // ── Boot + fixture sweep ────────────────────────────────────────────
        await runCase("App boots to the authenticated Home page with the deck grid", async () =>
        {
            await waitForPage(page, "home-page");
            await waitForVisible(page, "new-deck-tile");

            const tourDismissed = await dismissTutorialOverlayIfPresent(page);
            const overlayStillUp = await page.evaluate(() =>
            {
                const overlay = document.querySelector("tutorial-overlay");
                return Boolean(overlay) && overlay.style.display !== "none";
            });
            if (overlayStillUp)
            {
                throw new Error("A tutorial overlay is covering the Home page; the flows cannot reach the UI beneath it");
            }

            // Every flow below writes, and a write kicks the sync engine. If
            // the engine cannot settle, it raises a non-dismissible modal over
            // the whole app and nothing downstream is testable — establish that
            // up front rather than discovering it as 20 unrelated failures.
            try
            {
                await waitForSyncToSettle(page);
            }
            catch (syncError)
            {
                environmentBlockedReason =
                    "The sync backend never settled — the app sits behind the non-dismissible "
                    + `"Restoring sync state" modal, so no user flow can be exercised. `
                    + "Check that Dock's MongoDB and Redis are reachable and responsive from this machine. "
                    + `(${syncError.message})`;
                throw new EnvironmentUnavailableError(environmentBlockedReason);
            }

            const deckCount = await page.evaluate(() => document.querySelectorAll("deck-tile").length);
            return `home-page mounted, + tile present, sync settled, ${deckCount} existing deck tile(s)`
                + (tourDismissed ? " (an auto-played tour was dismissed first)" : "");
        });

        // Remove fixtures a previous interrupted run left behind, so tile
        // lookups by name can never match the wrong deck.
        await sweepLeftoverFixtures(page);

        // ── Deck lifecycle ──────────────────────────────────────────────────
        await runCase("Create a deck from the + tile (chooser → editor → save)", async () =>
        {
            await clickVisible(page, "new-deck-tile");
            await clickVisible(page, ".create-deck-choice-create");
            await waitForPage(page, "deck-editor-page");

            await typeIntoInput(page, ".deck-name-input", FIXTURE_DECK_NAME);
            await typeIntoInput(page, ".deck-short-name-input", FIXTURE_DECK_SHORT_NAME);
            await clickVisible(page, ".deck-save-input");

            await waitForPage(page, "home-page");
            const tileSelector = await waitUntil(page, deckTileSelectorInPage, FIXTURE_DECK_SHORT_NAME,
                `the new deck tile "${FIXTURE_DECK_SHORT_NAME}" on Home`);
            return `saved and returned to Home; tile ${tileSelector}`;
        });

        await runCase("Saving a deck with no name is rejected (validation, nothing created)", async () =>
        {
            const tileCountBefore = await page.evaluate(() => document.querySelectorAll("deck-tile").length);

            await clickVisible(page, "new-deck-tile");
            await clickVisible(page, ".create-deck-choice-create");
            await waitForPage(page, "deck-editor-page");
            await clickVisible(page, ".deck-save-input");

            let dialogText;
            try
            {
                dialogText = await waitForValidationDialogText(page, "the name-required validation dialog");
            }
            catch (waitError)
            {
                if (await syncModalIsUp(page))
                {
                    throw new EnvironmentUnavailableError(
                        "The sync modal is covering the app, so the deck editor's validation could not be reached. "
                        + "This environment's sync backend is not settling after a write — check Dock's MongoDB / Redis latency.");
                }
                throw waitError;
            }

            if (!/name/i.test(dialogText))
            {
                throw new Error(`Expected a name-required message, got: "${dialogText}"`);
            }

            await dismissAlert(page);

            // Backing out of the editor asks the user to confirm the discard.
            await clickVisible(page, ".deck-cancel-input");
            await dismissAlert(page);
            await waitForPage(page, "home-page");

            const tileCountAfter = await page.evaluate(() => document.querySelectorAll("deck-tile").length);
            if (tileCountAfter !== tileCountBefore)
            {
                throw new Error(`Deck count changed after a rejected save (${tileCountBefore} -> ${tileCountAfter})`);
            }
            return `blocked with "${dialogText.slice(0, 60)}"; deck count unchanged at ${tileCountAfter}`;
        });

        await runCase("Rename a deck via the options menu → Edit → Save", async () =>
        {
            await openDeckOptionsMenu(page, FIXTURE_DECK_SHORT_NAME);
            await clickVisible(page, "deck-options-context-menu .edit-button");
            await waitForPage(page, "deck-editor-page");

            await typeIntoInput(page, ".deck-name-input", FIXTURE_DECK_RENAMED);
            await clickVisible(page, ".deck-save-input");
            await waitForPage(page, "home-page");

            // The tile shows the SHORT name, so confirm the rename through the
            // editor's own field rather than the grid.
            await openDeckOptionsMenu(page, FIXTURE_DECK_SHORT_NAME);
            await clickVisible(page, "deck-options-context-menu .edit-button");
            await waitForPage(page, "deck-editor-page");
            const storedName = await page.evaluate(() =>
            {
                const input = Array.from(document.querySelectorAll(".deck-name-input"))
                    .find(candidate => candidate.getClientRects().length > 0);
                return input ? input.value : "";
            });
            await clickVisible(page, ".deck-cancel-input");
            await dismissAlert(page);
            await waitForPage(page, "home-page");

            if (storedName !== FIXTURE_DECK_RENAMED)
            {
                throw new Error(`Deck name did not persist: expected "${FIXTURE_DECK_RENAMED}", editor shows "${storedName}"`);
            }
            return `name persisted as "${storedName}"`;
        });

        await runCase("Drill into a deck — the grid shows its contents and a climb-out control", async () =>
        {
            const tileSelector = await deckTileSelector(page, FIXTURE_DECK_SHORT_NAME);
            await clickVisible(page, `${tileSelector} .deck-name-container`);
            await waitForVisible(page, ".back-to-parent-button");

            const backLabel = await page.evaluate(visibleTextInPage, ".back-to-parent-button");
            const stillOnHome = await currentPageTag(page);
            if (stillOnHome !== "home-page")
            {
                throw new Error(`Drilling in left the home page (now on <${stillOnHome}>)`);
            }
            return `drilled in; climb-out control reads "${backLabel}"`;
        });

        await runCase("Create a sub-deck inside the open deck, then climb back out", async () =>
        {
            await clickVisible(page, "new-deck-tile");
            await clickVisible(page, ".create-deck-choice-create");
            await waitForPage(page, "deck-editor-page");

            await typeIntoInput(page, ".deck-name-input", FIXTURE_SUB_DECK_NAME);
            await typeIntoInput(page, ".deck-short-name-input", FIXTURE_SUB_DECK_SHORT_NAME);
            await clickVisible(page, ".deck-save-input");
            await waitForPage(page, "home-page");

            const subTileSelector = await waitUntil(page, deckTileSelectorInPage, FIXTURE_SUB_DECK_SHORT_NAME,
                `the sub-deck tile "${FIXTURE_SUB_DECK_SHORT_NAME}" inside the parent`);

            await clickVisible(page, ".back-to-parent-button");
            await waitUntil(page, deckTileSelectorInPage, FIXTURE_DECK_SHORT_NAME,
                "the parent deck tile after climbing out");

            const subVisibleAtRoot = await deckTileSelector(page, FIXTURE_SUB_DECK_SHORT_NAME);
            if (subVisibleAtRoot)
            {
                throw new Error("The sub-deck is showing at the root level — it was not nested under its parent");
            }
            return `sub-deck created as ${subTileSelector} and nested (absent at root)`;
        });

        // ── Card authoring ──────────────────────────────────────────────────
        await runCase("Add a flashcard (menu → Add → Card → question + answer → Save)", async () =>
        {
            await openDeckOptionsMenu(page, FIXTURE_DECK_SHORT_NAME);
            await clickVisible(page, "deck-options-context-menu .add-button");
            await clickVisible(page, ".entity-picker-card-button");
            await waitForPage(page, "card-editor-page");

            await typeIntoRichTextEditor(page, ".question-editor", CARD_ONE_QUESTION);
            await typeIntoRichTextEditor(page, ".answer-editor", CARD_ONE_ANSWER);
            await clickVisible(page, "card-editor-page .save-button");

            // A brand-new card save keeps the editor open and blank, ready for
            // the next one — assert that, since the flow below relies on it.
            const editorCleared = await waitUntil(page, () =>
            {
                const editor = Array.from(document.querySelectorAll(".question-editor"))
                    .find(candidate => candidate.getClientRects().length > 0);
                const editable = editor ? editor.querySelector("[contenteditable]") : null;
                return editable ? (editable.textContent || "").trim().length === 0 : false;
            }, null, "the card editor to clear for the next card");

            return `card saved; editor cleared for the next entry (${editorCleared})`;
        });

        await runCase("Saving a card with no question is rejected (validation)", async () =>
        {
            await clickVisible(page, "card-editor-page .save-button");

            const dialogText = await waitForValidationDialogText(page, "the card validation dialog");

            if (!/question/i.test(dialogText))
            {
                throw new Error(`Expected a question-required message, got: "${dialogText}"`);
            }
            await dismissAlert(page);
            return `blocked with "${dialogText.slice(0, 60)}"`;
        });

        await runCase("Add a second flashcard so the study queue has depth", async () =>
        {
            await typeIntoRichTextEditor(page, ".question-editor", CARD_TWO_QUESTION);
            await typeIntoRichTextEditor(page, ".answer-editor", CARD_TWO_ANSWER);
            await clickVisible(page, "card-editor-page .save-button");
            await waitUntil(page, () =>
            {
                const editor = Array.from(document.querySelectorAll(".question-editor"))
                    .find(candidate => candidate.getClientRects().length > 0);
                const editable = editor ? editor.querySelector("[contenteditable]") : null;
                return editable ? (editable.textContent || "").trim().length === 0 : false;
            }, null, "the card editor to clear after the second save");

            await goBackViaHeader(page);
            await waitForPage(page, "home-page");
            return "second card saved; returned to Home";
        });

        await runCase("Browse the deck's cards (menu → Browse → Cards) — both are listed", async () =>
        {
            await openDeckOptionsMenu(page, FIXTURE_DECK_SHORT_NAME);
            await clickVisible(page, "deck-options-context-menu .browse-button");
            await clickVisible(page, ".entity-picker-card-button");
            await waitForPage(page, "browser-page");
            await waitForVisible(page, "card-list-item");

            const listedCount = await page.evaluate(() => document.querySelectorAll("card-list-item").length);
            if (listedCount < 2)
            {
                throw new Error(`Expected both cards to be listed, found ${listedCount}`);
            }
            return `${listedCount} cards listed`;
        });

        await runCase("Search inside Browse filters the card list", async () =>
        {
            await typeIntoInput(page, ".entity-search-input", "Mock Tests");
            const filteredCount = await waitUntil(page, () =>
            {
                const count = document.querySelectorAll("card-list-item").length;
                return count === 1 ? count : null;
            }, null, "the card list to narrow to a single match");

            await typeIntoInput(page, ".entity-search-input", "");
            await waitUntil(page, () => document.querySelectorAll("card-list-item").length >= 2,
                null, "the card list to restore when the search is cleared");
            return `search matched ${filteredCount} card; clearing it restored the full list`;
        });

        await runCase("Edit an existing card from Browse and save the change", async () =>
        {
            // A plain click on a row only SELECTS it; editing goes through the
            // row's own three-dot menu.
            const rowIndex = await page.evaluate((questionText) =>
            {
                const rows = Array.from(document.querySelectorAll("card-list-item"));
                return rows.findIndex(row => (row.textContent || "").includes(questionText));
            }, "Mock Tests");

            if (rowIndex < 0)
            {
                throw new Error("Could not find the second card's row in the browser list");
            }

            await clickVisible(page, `card-list-item:nth-of-type(${rowIndex + 1}) .card-options-button`);
            await waitForVisible(page, "card-options-context-menu");
            await clickVisible(page, "card-options-context-menu .edit-button");
            await waitForPage(page, "card-editor-page");

            // Append to the QUESTION: the browser row renders the question, so
            // that is the field whose change is observable from the list.
            await typeIntoRichTextEditor(page, ".question-editor", CARD_TWO_QUESTION_SUFFIX);
            await clickVisible(page, "card-editor-page .save-button");

            // Editing an EXISTING card returns the user where they came from.
            await waitForPage(page, "browser-page");
            const listText = await waitUntil(page, (expectedFragment) =>
            {
                const text = Array.from(document.querySelectorAll("card-list-item"))
                    .map(row => row.textContent || "").join(" ");
                return text.includes(expectedFragment) ? text.length : null;
            }, CARD_TWO_QUESTION_SUFFIX, "the edited question to appear in the browser list");

            return `edit saved and reflected in the list (${listText} chars listed)`;
        });

        await runCase("Add a study material and see it listed under Browse → Study Materials", async () =>
        {
            await goBackViaHeader(page);
            await waitForPage(page, "home-page");

            await openDeckOptionsMenu(page, FIXTURE_DECK_SHORT_NAME);
            await clickVisible(page, "deck-options-context-menu .add-button");
            await clickVisible(page, ".entity-picker-study-material-button");
            await waitForPage(page, "study-material-editor-page");

            await typeIntoRichTextEditor(page, ".content-editor", STUDY_MATERIAL_TEXT);
            await clickVisible(page, "study-material-editor-page .save-button");
            await sleep(SETTLE_MS);
            await goBackViaHeader(page);
            await waitForPage(page, "home-page");

            await openDeckOptionsMenu(page, FIXTURE_DECK_SHORT_NAME);
            await clickVisible(page, "deck-options-context-menu .browse-button");
            await clickVisible(page, ".entity-picker-study-material-button");
            await waitForPage(page, "browser-page");
            await waitForVisible(page, "study-material-list-item");

            const listedCount = await page.evaluate(() => document.querySelectorAll("study-material-list-item").length);
            await goBackViaHeader(page);
            await waitForPage(page, "home-page");

            if (listedCount < 1)
            {
                throw new Error("The saved study material is not listed");
            }
            return `${listedCount} study material listed`;
        });

        // ── Durability ──────────────────────────────────────────────────────
        await runCase("Everything created survives a full page reload", async () =>
        {
            // Reload only once the client says it is Synced. Reloading while a
            // sync cycle is in flight abandons the server-side lock it holds,
            // and the next boot is then blocked on "Couldn't acquire sync lock"
            // until that lock's TTL expires — a self-inflicted flake, and not
            // what a user reloading their tab normally does.
            await waitForSyncedIndicator(page);

            // "domcontentloaded", not "networkidle2": the boot sync can run
            // long enough that the network never goes idle inside the timeout.
            await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
            await waitForPage(page, "home-page");

            try
            {
                await waitForSyncToSettle(page);
            }
            catch (syncError)
            {
                // The boot sync never finished. That is a property of the
                // environment's sync backend, not of the flows under test, and
                // it leaves the app behind a non-dismissible modal — so report
                // it as an environment gap rather than a product failure.
                throw new EnvironmentUnavailableError(
                    `${syncError.message} — the app is blocked behind the boot sync modal, so persistence across a reload could not be exercised. `
                    + "Check that this environment's sync backend (Mongo + Redis reachable from Dock) is healthy.");
            }

            const tileSelector = await waitUntil(page, deckTileSelectorInPage, FIXTURE_DECK_SHORT_NAME,
                "the fixture deck tile to come back after a reload");

            await openDeckOptionsMenu(page, FIXTURE_DECK_SHORT_NAME);
            await clickVisible(page, "deck-options-context-menu .browse-button");
            await clickVisible(page, ".entity-picker-card-button");
            await waitForPage(page, "browser-page");
            await waitForVisible(page, "card-list-item");

            const cardCount = await page.evaluate(() => document.querySelectorAll("card-list-item").length);
            await goBackViaHeader(page);
            await waitForPage(page, "home-page");

            if (cardCount < 2)
            {
                throw new Error(`Only ${cardCount} card(s) survived the reload`);
            }
            return `deck ${tileSelector} and ${cardCount} cards survived the reload`;
        });

        // ── Study modes ─────────────────────────────────────────────────────
        await runCase("Spaced Repetition — Show Answer reveals the back of the card", async () =>
        {
            await openStudyModePicker(page, FIXTURE_DECK_SHORT_NAME);
            await clickVisible(page, ".spaced-repetition-button");
            await waitForPage(page, "study-page");
            await waitForVisible(page, ".question-section");

            const answerBefore = await page.evaluate(visibleTextInPage, ".answer-section");
            await clickVisible(page, ".show-answer-button");
            const answerAfter = await waitUntil(page, () =>
            {
                const section = Array.from(document.querySelectorAll(".answer-section"))
                    .find(candidate => candidate.getClientRects().length > 0);
                const text = section ? (section.textContent || "").trim() : "";
                return text.length > 0 ? text : null;
            }, null, "the answer to be revealed");

            if (answerBefore.length > 0)
            {
                throw new Error("The answer was already visible before Show Answer was clicked");
            }
            return `answer revealed: "${answerAfter.slice(0, 40)}"`;
        });

        await runCase("Study — the Assistant panel opens and closes on demand", async () =>
        {
            const labelBefore = await page.evaluate(visibleTextInPage, ".assistant-toggle-button");
            await ensureAssistantPanelOpen(page);
            await waitForVisible(page, ".bottom-panel-explain-button");

            const openHeight = await page.evaluate(() =>
            {
                const panel = document.querySelector("study-session-bottom-panel");
                return panel ? Math.round(panel.getBoundingClientRect().height) : 0;
            });
            const labelOpen = await page.evaluate(visibleTextInPage, ".assistant-toggle-button");

            await clickVisible(page, ".assistant-toggle-button");
            // Report the height as a string — waitUntil treats any falsy value
            // as "not ready yet", and a collapsed panel measures exactly 0.
            const collapsedHeight = await waitUntil(page, () =>
            {
                const panel = document.querySelector("study-session-bottom-panel");
                const height = panel ? panel.getBoundingClientRect().height : 999;
                return height < 5 ? `${Math.round(height)}px` : null;
            }, null, "the Assistant panel to collapse");

            // Leave it open — the Mark-for-Review case needs it.
            await ensureAssistantPanelOpen(page);

            if (openHeight < 20)
            {
                throw new Error(`The Assistant panel did not expand (height ${openHeight}px)`);
            }
            return `"${labelBefore}" → "${labelOpen}"; expanded ${openHeight}px, collapsed ${collapsedHeight}`;
        });

        await runCase("Study — Mark for Review toggles the card's review state", async () =>
        {
            const labelBefore = await page.evaluate(visibleTextInPage, ".bottom-panel-mark-review-toggle");
            await clickVisible(page, ".bottom-panel-mark-review-toggle");
            const labelAfter = await waitUntil(page, (previousLabel) =>
            {
                const button = Array.from(document.querySelectorAll(".bottom-panel-mark-review-toggle"))
                    .find(candidate => candidate.getClientRects().length > 0);
                const text = button ? button.textContent.trim() : "";
                return (text && text !== previousLabel) ? text : null;
            }, labelBefore, "the Mark-for-Review label to flip");

            if (!/remove/i.test(labelAfter))
            {
                throw new Error(`Expected the toggle to read "Remove from Review", got "${labelAfter}"`);
            }
            return `"${labelBefore}" → "${labelAfter}"`;
        });

        await runCase("Study — zoom controls scale the card and reset to 100%", async () =>
        {
            const readZoom = () => page.evaluate(() =>
            {
                const studyPage = Array.from(document.querySelectorAll("study-page"))
                    .find(candidate => candidate.getClientRects().length > 0);
                return studyPage ? (getComputedStyle(studyPage).getPropertyValue("--study-card-zoom") || "").trim() : "";
            });

            const zoomBefore = await readZoom();
            await clickVisible(page, ".study-zoom-increase-button");
            const zoomIncreased = await waitUntil(page, (previous) =>
            {
                const studyPage = Array.from(document.querySelectorAll("study-page"))
                    .find(candidate => candidate.getClientRects().length > 0);
                const value = studyPage ? (getComputedStyle(studyPage).getPropertyValue("--study-card-zoom") || "").trim() : "";
                return (value && value !== previous) ? value : null;
            }, zoomBefore, "the zoom multiplier to increase");

            await clickVisible(page, ".study-zoom-reset-button");
            const zoomReset = await waitUntil(page, (increased) =>
            {
                const studyPage = Array.from(document.querySelectorAll("study-page"))
                    .find(candidate => candidate.getClientRects().length > 0);
                const value = studyPage ? (getComputedStyle(studyPage).getPropertyValue("--study-card-zoom") || "").trim() : "";
                return (value && value !== increased) ? value : null;
            }, zoomIncreased, "the zoom multiplier to reset");

            return `zoom ${zoomBefore || "(default)"} → ${zoomIncreased} → reset ${zoomReset}`;
        });

        await runCase("Spaced Repetition — rating a card advances to the next one", async () =>
        {
            const questionBefore = await page.evaluate(visibleTextInPage, ".question-section");
            await clickVisible(page, ".user-score-section .neutral-button");

            const questionAfter = await waitUntil(page, (previous) =>
            {
                const section = Array.from(document.querySelectorAll(".question-section"))
                    .find(candidate => candidate.getClientRects().length > 0);
                const text = section ? (section.textContent || "").trim() : "";
                return (text && text !== previous) ? text : null;
            }, questionBefore, "the next card to be shown after rating");

            // Mark this one too, so Revise below has more than one card to
            // page through.
            await ensureAssistantPanelOpen(page);
            const markLabel = await page.evaluate(visibleTextInPage, ".bottom-panel-mark-review-toggle");
            if (/^mark/i.test(markLabel))
            {
                await clickVisible(page, ".bottom-panel-mark-review-toggle");
                await waitUntil(page, () =>
                {
                    const button = Array.from(document.querySelectorAll(".bottom-panel-mark-review-toggle"))
                        .find(candidate => candidate.getClientRects().length > 0);
                    const text = button ? button.textContent.trim() : "";
                    return /remove/i.test(text) ? text : null;
                }, null, "the second card to be marked for review");
            }

            return `advanced from "${questionBefore.slice(0, 30)}" to "${questionAfter.slice(0, 30)}"`;
        });

        await runCase("Leaving a study session returns to Home with the deck grid intact", async () =>
        {
            await goBackViaHeader(page);
            await waitForPage(page, "home-page");
            const tileSelector = await deckTileSelector(page, FIXTURE_DECK_SHORT_NAME);
            if (!tileSelector)
            {
                throw new Error("The deck tile is missing from Home after leaving the study session");
            }
            return `back on Home with ${tileSelector} present`;
        });

        await runCase("Ask AI actually charges the account (a real ledger row and a real balance drop)", async () =>
        {
            // The cheap half of the credit guarantee. A full generation is the
            // real proof that token usage reaches the ledger, but it costs
            // minutes and real money, so it lives in the on-demand
            // run_credit_charging_tests.js. This case costs one Ask AI call
            // (ASK_AI_BASIC, a flat 0.1 credit, and a FREE-tier feature so no
            // plan write is needed) and still catches the failure that matters
            // most here: the ledger not recording spend at all, which would mean
            // every AI feature in the app is silently free.
            const ledgerProbe = new CreditLedgerProbe(TEST_ACCOUNT_ID);
            const bConnected = await ledgerProbe.connect(REPOSITORY_ROOT);

            if (!bConnected)
            {
                throw new EnvironmentUnavailableError(
                    "MONGODB_URL / MONGODB_DATABASE_NAME are not readable from Dock/.env, so the credit ledger "
                    + "cannot be checked. The browser gates need Mongo anyway — run check_browser_gate_environment.js.");
            }

            try
            {
                const stateBefore = await ledgerProbe.readCreditState();
                const snapshotDate = new Date();

                // Deliberately placed AFTER the study block rather than inside
                // it: this case can legitimately SKIP (no Agent venv, no model
                // credentials), and runCase navigates home on a skip — which
                // from inside the study block would strand every study case
                // that followed. So it opens its own session and leaves the app
                // back on Home either way.
                await openStudyModePicker(page, FIXTURE_DECK_SHORT_NAME);
                await clickVisible(page, ".spaced-repetition-button");
                await waitForPage(page, "study-page");
                await waitForVisible(page, ".question-section");

                await ensureAssistantPanelOpen(page);
                await clickVisible(page, ".bottom-panel-explain-button");

                // Wait on the LEDGER, not on the DOM.
                //
                // Every DOM signal here lies about something. AskAiResultView
                // drops .ask-ai-pending on the FIRST chunk rather than the last;
                // its actions bar is never populated at all in some modes
                // (AskAiSession#wirePostStreamActions returns early during a
                // tutorial and with no context entity); and the
                // <ask-ai-result-view> host itself reports no client rects even
                // while its content is on screen, so the usual visible-match
                // filter never finds it. The charge is what this case asserts
                // and it settles a beat after the worker closes the stream, so
                // poll for it directly and use the DOM only to notice an error.
                let askAiCharge = null;
                let streamErrorText = "";

                const askAiDeadline = Date.now() + ASK_AI_STREAM_TIMEOUT_MS + ASK_AI_LEDGER_SETTLE_TIMEOUT_MS;
                while (Date.now() < askAiDeadline)
                {
                    askAiCharge = await ledgerProbe.waitForChargeOfTaskType(
                        CreditLedgerProbe.TASK_TYPE_ASK_AI_BASIC, snapshotDate, 2000);
                    if (askAiCharge)
                    {
                        break;
                    }

                    streamErrorText = await page.evaluate(() =>
                    {
                        const errorElement = Array.from(document.querySelectorAll(".ask-ai-error, .ask-ai-error-footer"))[0];
                        return errorElement ? (errorElement.textContent || "").trim() : "";
                    }).catch(() => "");

                    if (streamErrorText)
                    {
                        break;
                    }
                }

                if (!askAiCharge && streamErrorText)
                {
                    // A worker that cannot start is an environment problem, not
                    // the app being wrong — and it must not read as a
                    // credit-system failure.
                    throw new EnvironmentUnavailableError(
                        `Ask AI could not answer: ${streamErrorText}. This needs the Agent venv and working `
                        + "model credentials on this machine; the credit assertion was never reached.");
                }

                if (askAiCharge === null)
                {
                    throw new Error(
                        "Ask AI ran but NOTHING was charged — no applied TASK_CHARGE row for task type 31 since "
                        + "the request started. The credit ledger is not recording spend, so every AI feature is "
                        + "currently free.");
                }

                if (askAiCharge.amount >= 0)
                {
                    throw new Error(`The Ask AI ledger row carries amount ${askAiCharge.amount} — a charge must debit.`);
                }

                // Compared against the row's OWN balanceAfter rather than a fresh
                // read: the ledger's reward-milestone grants can move the balance
                // again a moment later, and a later read would blame that on this
                // charge.
                const expectedBalanceAfter = stateBefore.balance + askAiCharge.amount;
                if (!CreditLedgerProbe.creditsAreEqual(askAiCharge.balanceAfter, expectedBalanceAfter))
                {
                    throw new Error(
                        `The ledger charged ${Math.abs(askAiCharge.amount)} credit(s) but recorded a post-balance of `
                        + `${askAiCharge.balanceAfter} where ${expectedBalanceAfter} was due (pre-balance `
                        + `${stateBefore.balance}). The transaction row and the account balance disagree.`);
                }

                await page.evaluate(() =>
                {
                    const closeButton = Array.from(document.querySelectorAll("dialog-box .close-button, dialog-box .ok-button"))
                        .find(element => element.getClientRects().length > 0);
                    if (closeButton)
                    {
                        closeButton.click();
                    }
                }).catch(() => {});
                await waitForNoVisibleDialog(page).catch(() => {});

                // A completed Ask AI records a "doubt asked", which can raise a
                // milestone badge that owns the blocking-overlay slot and would
                // swallow the next case's clicks.
                await dismissBadgeCelebrationIfPresent(page);

                // Leave the app where the next case expects to find it.
                await returnToHome(page);

                return `charged ${Math.abs(askAiCharge.amount)} credit(s); balance ${stateBefore.balance} -> ${askAiCharge.balanceAfter}`;
            }
            finally
            {
                await ledgerProbe.close();
            }
        });

        await runCase("Revise mode plays back only the cards marked for review", async () =>
        {
            await openStudyModePicker(page, FIXTURE_DECK_SHORT_NAME);
            await clickVisible(page, ".revise-button");
            await waitForPage(page, "study-page");

            const progression = await waitUntil(page, () =>
            {
                const container = Array.from(document.querySelectorAll(".card-progression-container"))
                    .find(candidate => candidate.getClientRects().length > 0);
                const text = container ? (container.textContent || "").trim() : "";
                return /\d+\s*\/\s*\d+/.test(text) ? text : null;
            }, null, "the Revise progression counter");

            const total = Number(progression.split("/")[1]);
            if (!Number.isFinite(total) || total < 1)
            {
                throw new Error(`Revise reported an unusable card count: "${progression}"`);
            }
            return `revising ${progression} (only marked cards)`;
        });

        await runCase("Revise — Next / Previous page through the queue", async () =>
        {
            const readProgression = () => page.evaluate(visibleTextInPage, ".card-progression-container");
            const startProgression = await readProgression();
            const total = Number(startProgression.split("/")[1]);

            if (total < 2)
            {
                throw new Error(`Need at least 2 marked cards to page through; queue is "${startProgression}"`);
            }

            await clickVisible(page, ".next-card-button");
            const afterNext = await waitUntil(page, (previous) =>
            {
                const container = Array.from(document.querySelectorAll(".card-progression-container"))
                    .find(candidate => candidate.getClientRects().length > 0);
                const text = container ? (container.textContent || "").trim() : "";
                return (text && text !== previous) ? text : null;
            }, startProgression, "the counter to advance on Next");

            await clickVisible(page, ".previous-card-button");
            const afterPrevious = await waitUntil(page, (previous) =>
            {
                const container = Array.from(document.querySelectorAll(".card-progression-container"))
                    .find(candidate => candidate.getClientRects().length > 0);
                const text = container ? (container.textContent || "").trim() : "";
                return (text && text !== previous) ? text : null;
            }, afterNext, "the counter to step back on Previous");

            await goBackViaHeader(page);
            await waitForPage(page, "home-page");
            return `${startProgression} → ${afterNext} → ${afterPrevious}`;
        });

        await runCase("Content Study renders the deck's study material", async () =>
        {
            await openStudyModePicker(page, FIXTURE_DECK_SHORT_NAME);
            await clickVisible(page, ".content-study-button");

            // With a single detail level the picker is skipped entirely; with
            // more than one the user has to choose. Handle both.
            const outcomeDeadline = Date.now() + DEFAULT_WAIT_MS;
            let pickerAppeared = false;
            let reachedStudyPage = false;
            while (Date.now() < outcomeDeadline && !pickerAppeared && !reachedStudyPage)
            {
                pickerAppeared = await page.evaluate(visibleMatchExistsInPage, ".detail-level-picker-start");
                reachedStudyPage = (await currentPageTag(page)) === "study-page";
                if (!pickerAppeared && !reachedStudyPage)
                {
                    await sleep(POLL_INTERVAL_MS);
                }
            }

            if (!pickerAppeared && !reachedStudyPage)
            {
                throw new Error("Content Study opened neither the detail-level picker nor the study page");
            }

            if (pickerAppeared)
            {
                await clickVisible(page, ".detail-level-picker-start");
            }

            await waitForPage(page, "study-page");
            const materialText = await waitUntil(page, () =>
            {
                const section = Array.from(document.querySelectorAll(".study-material-content-section"))
                    .find(candidate => candidate.getClientRects().length > 0);
                const text = section ? (section.textContent || "").trim() : "";
                return text.length > 0 ? text : null;
            }, null, "the study material content to render");

            await goBackViaHeader(page);
            await waitForPage(page, "home-page");

            if (!materialText.includes("Acquire"))
            {
                throw new Error(`The rendered material is not the one that was authored: "${materialText.slice(0, 60)}"`);
            }
            return `material rendered (${materialText.length} chars)`;
        });

        await runCase("Deck Insights opens from the deck menu and renders", async () =>
        {
            await openDeckOptionsMenu(page, FIXTURE_DECK_SHORT_NAME);
            await clickVisible(page, "deck-options-context-menu .insights-button");
            await waitForPage(page, "deck-insights-page");

            const rendered = await waitUntil(page, () =>
            {
                const insightsPage = Array.from(document.querySelectorAll("deck-insights-page"))
                    .find(candidate => candidate.getClientRects().length > 0);
                const text = insightsPage ? (insightsPage.textContent || "").trim() : "";
                return text.length > 0 ? text.length : null;
            }, null, "the Deck Insights page to render content");

            await goBackViaHeader(page);
            await waitForPage(page, "home-page");
            return `insights page rendered (${rendered} chars of content)`;
        });

        await runCase("Start Generation prices the run before submitting anything (no AI spend)", async () =>
        {
            // Costs nothing and needs nothing beyond Dock: /Generate/EstimateCost
            // is pure arithmetic over the stored credit configuration — no model
            // call, no task, no charge, no plan gate. What it catches is a
            // credit-system OUTAGE: a missing or corrupt creditConfig document,
            // generation rules that were never seeded, or an admin edit that
            // disabled every rule. All of those would let real generations run
            // unpriced, and none of them are visible anywhere else in the UI.
            //
            // Pressing Start no longer submits — it prices the run and waits for
            // a confirmation inside the estimate dialog — so this case reaches
            // the estimate through the real user route and then CANCELS.
            await openDeckOptionsMenu(page, FIXTURE_DECK_SHORT_NAME);
            await clickVisible(page, "deck-options-context-menu .generate-with-ai-button");
            await waitForPage(page, "automatic-generation-page");

            // A description-only run: no upload, no object storage, no worker.
            await typeIntoInput(page, ".subject-name-input", `${FIXTURE_PREFIX} Pricing ${RUN_TAG}`);
            await typeIntoInput(page, ".description-input", "A short revision set on the five-phase learning lifecycle.");

            await clickVisible(page, ".automatic-generation-start-button");
            const estimateText = await waitForValidationDialogText(page, "the cost-estimate dialog");

            // CANCEL, never OK. The confirming button in this dialog starts a
            // real generation and spends real credits — this case must remain
            // free. Every assertion below therefore runs after the dialog is
            // already dismissed.
            await clickVisible(page, "dialog-box .cancel-button");
            await waitForNoVisibleDialog(page);

            // Estimating is rate-limited per user. The client re-uses its last
            // answer for an unchanged form, so this is now hard to hit, but a
            // back-to-back suite run still can — that is the limiter working,
            // not a defect.
            if (/again in \d+|too many requests|rate limit|too quickly/i.test(estimateText))
            {
                throw new EnvironmentUnavailableError(
                    `The pre-flight estimate was rate-limited: "${estimateText.slice(0, 120)}". Re-run in 30 seconds.`);
            }

            if (/isn't configured yet|is not configured/i.test(estimateText))
            {
                throw new Error(
                    "The pre-flight estimate reports that credit pricing is not configured — the credit configuration "
                    + "is missing or unreadable, so real generations would run unpriced.");
            }

            if (/not priced/i.test(estimateText))
            {
                throw new Error(
                    `The pre-flight estimate reports unpriced generation tasks, so a real run would be partly free: "${estimateText.slice(0, 160)}"`);
            }

            const estimatedCredits = Number((/([\d.]+)\s*credit/i.exec(estimateText) || [])[1]);
            if (!Number.isFinite(estimatedCredits) || estimatedCredits <= 0)
            {
                throw new Error(`The pre-flight estimate returned no positive figure from "${estimateText.slice(0, 160)}"`);
            }

            // The disclaimer is the reason this dialog exists — a costed run the
            // user cannot mistake for an exact price. Its absence means the
            // estimate rendered without its caveat.
            if (!/estimate/i.test(estimateText))
            {
                throw new Error(`The estimate dialog carried no estimate disclaimer: "${estimateText.slice(0, 200)}"`);
            }

            await goBackViaHeader(page).catch(() => {});
            await dismissAlert(page).catch(() => {});
            await waitForPage(page, "home-page");

            return `estimated ${estimatedCredits} credit(s) from the live pricing config, then cancelled`;
        });

        await runCase("Delete a deck (menu → Edit → Delete Deck → confirm) removes it from Home", async () =>
        {
            await openDeckOptionsMenu(page, FIXTURE_DECK_SHORT_NAME);
            await clickVisible(page, "deck-options-context-menu .edit-button");
            await waitForPage(page, "deck-editor-page");
            await clickVisible(page, ".deck-delete-input");
            await clickVisible(page, "dialog-box .ok-button");

            await waitForPage(page, "home-page");
            const stillPresent = await waitUntil(page, (shortName) =>
            {
                const tiles = Array.from(document.querySelectorAll("deck-tile"))
                    .filter(tile => tile.getClientRects().length > 0);
                const match = tiles.find(tile =>
                {
                    const nameElement = tile.querySelector(".deck-name-container");
                    return nameElement && nameElement.textContent.trim() === shortName;
                });
                return match ? null : "gone";
            }, FIXTURE_DECK_SHORT_NAME, "the deleted deck tile to disappear from Home");

            return `deck removed from the grid (${stillPresent})`;
        });

        // Placed last because it is the only case that navigates the browser by
        // URL rather than by clicking: it re-enters the app through the
        // paid-deck deep-link route, which is a second door onto the same SPA
        // shell. It restores the standard entry point before finishing.
        await runCase("A paid-deck share link opens that deck's store page with a scannable QR", async () =>
        {
            const publishedDeck = await page.evaluate(async () =>
            {
                try
                {
                    const response = await fetch("/PaidDecks/Library?limit=1");
                    if (!response.ok)
                    {
                        return { error: `HTTP ${response.status}` };
                    }
                    const payload = await response.json();
                    const firstDeck = Array.isArray(payload?.decks) ? payload.decks[0] : null;
                    return firstDeck ? { id: firstDeck.id, title: firstDeck.title || "" } : { error: "" };
                }
                catch (fetchError)
                {
                    return { error: fetchError.message || String(fetchError) };
                }
            });

            if (!publishedDeck || !publishedDeck.id)
            {
                throw new EnvironmentUnavailableError(
                    "This environment has no published paid deck, so there is no store page to deep-link to"
                    + (publishedDeck?.error ? ` (${publishedDeck.error})` : "") + ".");
            }

            const shareUrl = `${BASE_URL}/PaidDeck?id=${encodeURIComponent(publishedDeck.id)}&tutorialE2E=1`;
            await page.goto(shareUrl, { waitUntil: "networkidle2", timeout: 30000 });

            await waitForPage(page, "paid-deck-details-page");

            // The QR itself, not just the section around it. A non-zero width
            // proves the lazily-injected ThirdParty/QrCode script actually
            // resolved over real HTTP under the real cache policy — the part
            // that a bundling or path mistake would silently break.
            const qrWidth = await waitUntil(page, () =>
            {
                const svgElement = document.querySelector("paid-deck-share-qr-panel svg");
                if (!svgElement)
                {
                    return null;
                }
                const width = Math.round(svgElement.getBoundingClientRect().width);
                return width > 0 ? width : null;
            }, null, "the share QR code to render");

            const panelState = await page.evaluate(() =>
            {
                const linkField = document.querySelector('paid-deck-share-qr-panel [data-role="share-link"]');
                const headings = Array.from(document.querySelectorAll(".paid-deck-details-section-heading"))
                    .map(heading => (heading.textContent || "").trim());
                return {
                    linkValue: linkField ? linkField.value : "",
                    bHasShareHeading: headings.includes("Share this deck"),
                    bHasDownloadButton: Boolean(document.querySelector('paid-deck-share-qr-panel [data-role="download-qr"]')),
                    bHasCopyButton: Boolean(document.querySelector('paid-deck-share-qr-panel [data-role="copy-link"]')),
                    search: window.location.search
                };
            });

            if (!panelState.bHasShareHeading)
            {
                throw new Error("The deep-linked store page rendered without the 'Share this deck' section.");
            }

            if (!panelState.bHasDownloadButton || !panelState.bHasCopyButton)
            {
                throw new Error("The share panel is missing its Download QR / Copy link actions.");
            }

            const expectedLink = `${BASE_URL}/PaidDeck?id=${publishedDeck.id}`;
            if (panelState.linkValue !== expectedLink)
            {
                throw new Error(`The share link field reads "${panelState.linkValue}" but should read "${expectedLink}".`);
            }

            // The deck ID is consumed out of the address bar, so a refresh or a
            // back press cannot re-fire the navigation.
            if (panelState.search !== "")
            {
                throw new Error(`The deep-link query string was left in the address bar: "${panelState.search}".`);
            }

            // Back through the standard entry point so whatever runs after this
            // case starts from the same state every other case did.
            await page.goto(BASE_URL + "/index.html?tutorialE2E=1", { waitUntil: "networkidle2", timeout: 30000 });
            await waitForPage(page, "home-page");

            return `deep-linked to ${publishedDeck.title || publishedDeck.id}, QR rendered at ${qrWidth}px`;
        });

        // ── Whole-run error gate ────────────────────────────────────────────
        cases.push({
            name: "No client-side script errors during the flows",
            status: scriptErrors.length === 0 ? "PASS" : "FAIL",
            detail: scriptErrors.slice(0, 5).join(" | ") || "no pageerror captured",
        });
    }
    catch (fatalError)
    {
        cases.push({ name: "Suite ran to completion", status: "FAIL", detail: `Unexpected driver error: ${fatalError.message}` });
    }
    finally
    {
        if (page)
        {
            // Best effort: never leave a fixture deck behind on the account.
            await sweepLeftoverFixtures(page).catch(() => {});
        }
        if (browser)
        {
            await browser.close();
        }
    }

    const passed = cases.filter(testCase => testCase.status === "PASS").length;
    const failed = cases.filter(testCase => testCase.status === "FAIL").length;
    const skipped = cases.filter(testCase => testCase.status === "SKIPPED").length;
    const flowCases = cases.filter(testCase => /^\d\d\./.test(testCase.name));
    const flowsPassed = flowCases.filter(testCase => testCase.status === "PASS").length;
    const percent = flowCases.length > 0
        ? Math.round(1000 * flowsPassed / flowCases.length) / 10
        : null;

    writeResult({
        service: "Main",
        category: CATEGORY,
        // A skipped flow is never a pass: it means the environment could not
        // prove that flow works, which a deployment gate must treat as a stop.
        status: failed > 0 ? "FAIL" : (skipped > 0 || passed === 0 ? "SKIPPED" : "PASS"),
        passed, failed, skipped, total: cases.length,
        coverage: {
            kind: "flows",
            label: "Flows exercised",
            percent,
            covered: flowsPassed,
            total: flowCases.length,
            detail: `${flowsPassed}/${flowCases.length} critical user flows passed end to end`,
        },
        metrics: {
            label: "Critical flows",
            flowsAttempted: flowCases.length,
            flowsPassed,
            scriptFaults: scriptErrors.length,
        },
        cases,
        notes: `${flowsPassed}/${flowCases.length} critical flows passed; ${scriptErrors.length} script fault(s).`,
    });

    console.log(`Main ${CATEGORY}: ${passed} passed, ${failed} failed, ${skipped} skipped`
        + (percent !== null ? `, ${percent}% flows` : ""));
})().catch(error =>
{
    skip(`Unexpected runner error: ${error && error.message}`);
    process.exit(0);
});

// -- Fixture housekeeping -----------------------------------------------------

// Deletes every deck whose name carries the fixture prefix, through the real
// deck-editor delete flow, so a run that died mid-way cannot poison the next
// one (or leave litter on the account). Root-level tiles only — sub-decks go
// with their parent.
async function sweepLeftoverFixtures(page)
{
    for (let attempt = 0; attempt < 6; attempt++)
    {
        const onHome = await returnToHome(page);
        if (!onHome)
        {
            return;
        }

        const staleShortName = await page.evaluate((prefix) =>
        {
            const tiles = Array.from(document.querySelectorAll("deck-tile"))
                .filter(tile => tile.getClientRects().length > 0);
            const match = tiles.find(tile =>
            {
                const nameElement = tile.querySelector(".deck-name-container");
                return nameElement && nameElement.textContent.trim().startsWith(prefix);
            });
            return match ? match.querySelector(".deck-name-container").textContent.trim() : "";
        }, FIXTURE_PREFIX);

        if (!staleShortName)
        {
            return;
        }

        trace(`  (sweeping leftover fixture deck "${staleShortName}")`);
        try
        {
            await openDeckOptionsMenu(page, staleShortName);
            await clickVisible(page, "deck-options-context-menu .edit-button");
            await waitForPage(page, "deck-editor-page");
            await clickVisible(page, ".deck-delete-input");
            await clickVisible(page, "dialog-box .ok-button");
            await waitForPage(page, "home-page");
        }
        catch (sweepError)
        {
            trace(`  (sweep failed for "${staleShortName}": ${sweepError.message})`);
            return;
        }
    }
}
