// Browser tests for SYNCHRONISATION, driven by a real Chromium via Puppeteer
// against the BUILT app (Dock/Static) and asserted against MongoDB.
//
// Sync is the subsystem where the app is least able to tell you it is wrong. A
// client that pushed nothing still shows "Synced ✓". A client that dropped half
// the server's rows shows a smaller library, not an error. A drain that never
// converges shows a progress bar that keeps moving. Every one of those looks
// healthy from inside the browser, which is why every case here pairs a
// browser-visible outcome with the server's own state, and why several drive
// TWO independent devices — a second browser context with its own IndexedDB,
// its own device id and its own sync log, which is the only way to prove that
// what one device wrote another one actually receives.
//
//   node Common/Testing/Main/run_sync_ui_tests.js
//
// Env: BASE_URL (default http://127.0.0.1:3000),
//      TEST_SESSION_COOKIE (REQUIRED — a seeded, terms-accepted session; without
//      it the home page never loads and the whole suite is SKIPPED, never
//      FAILED),
//      TEST_ACCOUNT_ID (default browser-suite-test-user — MUST be the session's
//      user or every database assertion is measured against the wrong account),
//      MONGODB_URL / MONGODB_DATABASE_NAME override Dock/.env,
//      DRAIN_CARD_COUNT (default 260 — must stay above the server's
//      MAX_PULL_PER_COLLECTION or the drain cases prove nothing),
//      KEEP_FIXTURES=1 to leave the fixture deck behind for inspection,
//      HEADFUL=1 / SLOW_MO_MS / VERBOSE=1 as in the other suites.
// Result JSON -> $RESULT_FILE or Common/Reports/.results/sync-ui.json.
//
// The fixture deck and every row under it are created and swept by the suite
// itself, so it is safe to run repeatedly. It is NOT safe to point at a real
// account: point TEST_ACCOUNT_ID at the throwaway one seed_browser_test_account.js
// creates.

const fs = require("fs");
const path = require("path");

const { BrowserSuiteHelpers, EnvironmentUnavailableError } = require("./BrowserSuiteHelpers");
const SyncDatabaseProbe = require("./SyncDatabaseProbe");

const REPOSITORY_ROOT = path.resolve(__dirname, "..", "..", "..");
const RESULT_FILE = process.env.RESULT_FILE
    || path.join(REPOSITORY_ROOT, "Common", "Reports", ".results", "sync-ui.json");
const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:3000";
const SESSION_COOKIE = process.env.TEST_SESSION_COOKIE || "";
const TEST_ACCOUNT_ID = process.env.TEST_ACCOUNT_ID || "browser-suite-test-user";
const CATEGORY = "Synchronisation (Puppeteer)";
const RUN_HEADFUL = process.env.HEADFUL === "1";
const SLOW_MO_MS = Number(process.env.SLOW_MO_MS || 0) || 0;
const VERBOSE = process.env.VERBOSE === "1";
const KEEP_FIXTURES = process.env.KEEP_FIXTURES === "1";

// Must stay ABOVE the server's MAX_PULL_PER_COLLECTION (200 in
// Dock/Endpoints/Sync/Sync.js) or the pull fits in one cycle, `morePending` is
// never set, and the four drain cases below silently assert nothing. Duplicated
// here rather than imported so a cap change in the endpoint surfaces as a
// failure in this suite instead of quietly disarming it.
const SERVER_MAX_PULL_PER_COLLECTION = 200;
const DRAIN_CARD_COUNT = Number(process.env.DRAIN_CARD_COUNT) || 260;

const FIXTURE_PREFIX = "ZZSync";
const RUN_TAG = String(Date.now()).slice(-6);
const FIXTURE_DECK_NAME = `${FIXTURE_PREFIX} Deck ${RUN_TAG}`;
const FIXTURE_DECK_SHORT_NAME = `${FIXTURE_PREFIX}D${RUN_TAG}`;
const FIXTURE_DECK_RENAMED = `${FIXTURE_PREFIX} Deck Renamed ${RUN_TAG}`;
const FIXTURE_SUB_DECK_NAME = `${FIXTURE_PREFIX} Sub ${RUN_TAG}`;
const FIXTURE_SUB_DECK_SHORT_NAME = `${FIXTURE_PREFIX}S${RUN_TAG}`;
const FIXTURE_OFFLINE_NAME = `${FIXTURE_PREFIX} Offline ${RUN_TAG}`;
const FIXTURE_CARD_QUESTION = `${FIXTURE_PREFIX} question ${RUN_TAG}`;
const FIXTURE_CARD_ANSWER = `${FIXTURE_PREFIX} answer ${RUN_TAG}`;

// A drain of several hundred entities is several round trips, each doing real
// IndexedDB work, so it needs materially longer than the generic waits.
const DRAIN_TIMEOUT_MS = 5 * 60 * 1000;
const SYNC_CYCLE_TIMEOUT_MS = 2 * 60 * 1000;

// Hard ceiling on the whole run.
//
// Every individual wait in here is bounded, but "every wait I know about" is
// not the same as "every wait" — this suite drives three browsers through a
// stalled-sync-prone subsystem, and a gate that HANGS is strictly worse than
// one that fails: CI waits on it forever instead of reporting, and the operator
// gets no result file to read at all. So the run gets an outer deadline that
// writes a FAIL with whatever was proved so far and exits.
const SUITE_TIMEOUT_MS = Number(process.env.SYNC_SUITE_TIMEOUT_MINUTES || 25) * 60 * 1000;

BrowserSuiteHelpers.configure({ bVerbose: VERBOSE });

const sleep = BrowserSuiteHelpers.sleep;
const trace = BrowserSuiteHelpers.trace;
const clickVisible = (page, selector) => BrowserSuiteHelpers.clickVisible(page, selector);
const waitForVisible = (page, selector, description) => BrowserSuiteHelpers.waitForVisible(page, selector, description);
const waitForPage = (page, tag) => BrowserSuiteHelpers.waitForPage(page, tag);
const waitUntil = (page, fn, argument, description, timeout) => BrowserSuiteHelpers.waitUntil(page, fn, argument, description, timeout);
const typeIntoInput = (page, selector, text) => BrowserSuiteHelpers.typeIntoInput(page, selector, text);
const dismissAlert = (page) => BrowserSuiteHelpers.dismissAlert(page);

function writeResult(payload)
{
    fs.mkdirSync(path.dirname(path.resolve(RESULT_FILE)), { recursive: true });
    fs.writeFileSync(RESULT_FILE, JSON.stringify(payload, null, 2), "utf-8");
}

function skip(note)
{
    writeResult({
        service: "Main", category: CATEGORY, status: "SKIPPED",
        passed: 0, failed: 0, skipped: 1, total: 0,
        coverage: { kind: "flows", label: "Sync behaviours proven", percent: null, detail: note },
        cases: [], notes: note,
    });
    console.log(`Main ${CATEGORY}: SKIPPED - ${note}`);
}

let puppeteer;
try
{
    puppeteer = require("puppeteer");
}
catch (requireError)
{
    skip("puppeteer not installed; run `npm install` in Common/Testing/Main.");
    process.exit(0);
}

if (!SESSION_COOKIE)
{
    skip("TEST_SESSION_COOKIE is not set; run seed_browser_test_account.js and export the printed cookie.");
    process.exit(0);
}

// ── Sync event recorder ────────────────────────────────────────────────────
//
// Installed via evaluateOnNewDocument so it is listening BEFORE any app script
// runs — a recorder attached after boot misses the first sync entirely, which
// is the one that matters most. It only listens to public window CustomEvents.
//
// The event names are written out literally rather than referenced from a
// constant: this function is serialised and re-evaluated inside the browser, so
// it cannot close over anything in this file. They are the public names in
// Main/Globals/Events/SyncEvents.js.

function installSyncRecorderInPage()
{
    window.__syncRecorder =
    {
        entityProgress: [],
        started: 0,
        completed: 0,
        failed: [],
        lockBlocked: 0,
        deferred: 0,
    };

    window.addEventListener("sync-entity-progress", (event) =>
    {
        const detail = event.detail || {};
        window.__syncRecorder.entityProgress.push(
        {
            processed: detail.processed || 0,
            total: detail.total || 0,
            phase: detail.phase || "",
            at: Date.now(),
        });
    });
    window.addEventListener("sync-started", () => { window.__syncRecorder.started += 1; });
    window.addEventListener("sync-completed", () => { window.__syncRecorder.completed += 1; });
    window.addEventListener("sync-failed", (event) =>
    {
        const errorDetail = event.detail && event.detail.error;
        window.__syncRecorder.failed.push(String((errorDetail && errorDetail.message) || errorDetail || "unknown"));
    });
    window.addEventListener("sync-lock-blocked", () => { window.__syncRecorder.lockBlocked += 1; });
    window.addEventListener("sync-deferred", () => { window.__syncRecorder.deferred += 1; });
}

async function resetSyncRecorder(page)
{
    await page.evaluate(() =>
    {
        if (!window.__syncRecorder)
        {
            return;
        }
        window.__syncRecorder.entityProgress = [];
        window.__syncRecorder.started = 0;
        window.__syncRecorder.completed = 0;
        window.__syncRecorder.failed = [];
        window.__syncRecorder.lockBlocked = 0;
        window.__syncRecorder.deferred = 0;
    });
}

async function readSyncRecorder(page)
{
    return page.evaluate(() => window.__syncRecorder || null);
}

// ── Device driving ─────────────────────────────────────────────────────────

/**
 * Opens a device: a browser context with its own storage, therefore its own
 * device id, its own sync log and its own IndexedDB copy of the library. Two
 * pages in the SAME context would share all three and could not tell a real
 * cross-device pull from a same-tab read.
 */
async function openDevice(browser, deviceLabel, scriptErrors)
{
    const context = await browser.createBrowserContext();
    const page = await context.newPage();

    page.on("pageerror", pageError => scriptErrors.push(`[${deviceLabel}] pageerror: ${pageError.message}`));
    await page.evaluateOnNewDocument(installSyncRecorderInPage);
    await page.setCookie({ name: "sessionId", value: SESSION_COOKIE, url: BASE_URL });

    return { context, page, label: deviceLabel };
}

/**
 * Skips a guided tour that has put itself on screen.
 *
 * Every device this suite opens is a fresh browser profile, which the app reads
 * as a first launch — so the Beginners tour auto-plays and its overlay swallows
 * every click underneath it, including the first fullscreen infographic it
 * opens. `?tutorialE2E=1` below marks the tours completed and is the real fix;
 * this is the safety net for an autoplay that beat the seam being installed.
 * Walking the tours is run_tutorial_ui_tests.js's job, not this suite's.
 */
async function dismissTutorialOverlayIfPresent(page)
{
    const bAnythingToDismiss = await page.evaluate(() =>
    {
        const overlay = document.querySelector("tutorial-overlay");
        const bOverlayUp = Boolean(overlay) && overlay.style.display !== "none";
        const bLightboxUp = Array.from(document.querySelectorAll(".fullscreen-image-viewer-close"))
            .some(element => element.getClientRects().length > 0);
        return bOverlayUp || bLightboxUp;
    }).catch(() => false);

    if (!bAnythingToDismiss)
    {
        return false;
    }

    // The lightbox sits ON TOP of the tour overlay, so its close button has to
    // go first or the skip press lands on the poster instead.
    await page.evaluate(() =>
    {
        const closeButton = Array.from(document.querySelectorAll(".fullscreen-image-viewer-close"))
            .find(element => element.getClientRects().length > 0);
        if (closeButton)
        {
            closeButton.click();
        }
    }).catch(() => {});
    await sleep(600);

    await page.evaluate(() =>
    {
        const overlay = document.querySelector("tutorial-overlay");
        const skipButton = overlay ? overlay.querySelector(".tutorial-overlay-skip-button") : null;
        if (skipButton)
        {
            skipButton.click();
        }
    }).catch(() => {});
    await sleep(1200);
    await page.evaluate(() => document.querySelector(".tutorial-finish-done-button")?.click()).catch(() => {});
    await sleep(800);
    return true;
}

async function bootDevice(device)
{
    // "/index.html?..." rather than "/?..." — the server's route normalisation
    // drops the root path when a query string is present. The tutorialE2E flag
    // marks the tours completed so the Beginners tour does not auto-play over
    // everything this suite is trying to click.
    await device.page.goto(`${BASE_URL}/index.html?tutorialE2E=1`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await waitForPage(device.page, "home-page");

    // Let the boot sequence install the seam — and so suppress autoplay —
    // before the first click goes anywhere near the page.
    const seamDeadline = Date.now() + 20000;
    while (Date.now() < seamDeadline)
    {
        if (await device.page.evaluate(() => Boolean(window.__tutorialE2E)).catch(() => false))
        {
            break;
        }
        await sleep(300);
    }

    await dismissTutorialOverlayIfPresent(device.page);

    // The session user arrives asynchronously and several controls branch on it
    // (the + tile most visibly). Nothing this suite does is meaningful before
    // it lands anyway — sync itself will not start without it.
    await waitUntil(device.page, () => Boolean(window["user"]), null,
        `[${device.label}] the session user to be populated`, 30000);

    const bSettled = await BrowserSuiteHelpers.waitForSyncToSettle(device.page);
    if (!bSettled)
    {
        throw new Error(`[${device.label}] the boot sync never settled — the blocking modal stayed up`);
    }

    // Autoplay can still raise the tour a beat after the first sync lands.
    await dismissTutorialOverlayIfPresent(device.page);
    return device;
}

/**
 * Triggers a manual sync the way a user does — by clicking the sync pill — and
 * waits for the cycle to finish.
 *
 * Waiting on the COMPLETED event rather than on the modal disappearing matters
 * for the drain cases: a multi-chunk drain deliberately suppresses COMPLETED
 * until its FINAL chunk, so the event is the only signal that distinguishes
 * "between chunks" from "done".
 */
async function syncNowAndWait(device, timeoutMilliseconds = SYNC_CYCLE_TIMEOUT_MS)
{
    const page = device.page;

    // The sync pill lives in the Home footer, and an open context menu's
    // backdrop absorbs a click on it. Both leave the recorder reporting
    // "started 0" — a sync that was never asked for, reported as a sync that
    // never finished.
    await closeAnyContextMenu(page);
    await clearBlockingChromeIfPresent(page, device.label);
    await BrowserSuiteHelpers.returnToHome(page);
    await BrowserSuiteHelpers.waitForSyncToSettle(page);
    await resetSyncRecorder(page);

    // Press until the cycle actually starts rather than assuming the click
    // landed. SyncStatusComponent ignores a press while a cycle is already
    // running, so an already-started sync counts too.
    await BrowserSuiteHelpers.clickUntil(page, "sync-status-component",
        () => (window.__syncRecorder && (window.__syncRecorder.started > 0 || window.__syncRecorder.completed > 0)) ? "started" : null,
        null, `[${device.label}] a sync cycle to start`);

    const deadline = Date.now() + timeoutMilliseconds;
    while (Date.now() < deadline)
    {
        const recorder = await readSyncRecorder(page);
        if (recorder && recorder.failed.length > 0)
        {
            throw new Error(`[${device.label}] sync reported failure: ${recorder.failed.join(" | ")}`);
        }
        if (recorder && recorder.completed > 0)
        {
            await BrowserSuiteHelpers.waitForSyncToSettle(page);
            await sleep(BrowserSuiteHelpers.SETTLE_MS);
            return recorder;
        }
        await sleep(250);
    }

    const finalRecorder = await readSyncRecorder(page);
    throw new Error(`[${device.label}] sync did not complete within ${Math.round(timeoutMilliseconds / 1000)}s `
        + `(started ${finalRecorder ? finalRecorder.started : "?"}, progress events ${finalRecorder ? finalRecorder.entityProgress.length : "?"})`);
}

async function deckTileSelector(page, shortName)
{
    return page.evaluate(BrowserSuiteHelpers.deckTileSelectorInPage, shortName);
}

// Devices on which an orphaned dialog backdrop had to be cleared. Recorded
// rather than silently swallowed: a `.dialog-backdrop` left in the DOM with no
// dialog attached is INVISIBLE and absorbs every click, so to a user the app
// has simply stopped responding. Recovering lets the remaining cases still
// prove their behaviour; case 19 then reports that it happened, so the
// recovery can never quietly hide it.
const orphanedBackdropRecoveries = [];

/**
 * Clears anything modal that is covering the app but is NOT the sync modal.
 *
 * The sync modal is deliberately exempt — dismissing it abandons an in-flight
 * sync and leaves the server-side lock held for its full TTL. Callers wait that
 * one out instead.
 *
 * Two shapes are handled. A real dialog is answered through its own button so
 * the app's awaiting promise resolves. An ORPHANED backdrop — present with no
 * visible dialog — has no button to press and can only be cleared by removing
 * it; that path is recorded in orphanedBackdropRecoveries so it is reported
 * rather than papered over.
 */
async function clearBlockingChromeIfPresent(page, deviceLabel)
{
    if (await BrowserSuiteHelpers.syncModalIsUp(page).catch(() => false))
    {
        return false;
    }

    const outcome = await page.evaluate(() =>
    {
        const isOnScreen = element => element.getClientRects().length > 0;
        const visibleDialogs = Array.from(document.querySelectorAll("dialog-box")).filter(isOnScreen);

        if (visibleDialogs.length > 0)
        {
            const answerButton = visibleDialogs[visibleDialogs.length - 1]
                .querySelector(".ok-button, .close-button, .cancel-button");
            if (answerButton)
            {
                answerButton.click();
                return "answered-dialog";
            }
            return "dialog-without-button";
        }

        const backdrops = Array.from(document.querySelectorAll(".dialog-backdrop"));
        if (backdrops.length > 0)
        {
            // No dialog on screen, yet a backdrop is still hit-testable over
            // the whole page. Nothing can be clicked until it goes.
            for (const backdrop of backdrops)
            {
                backdrop.remove();
            }
            return `orphaned-backdrop:${backdrops.length}`;
        }

        return "";
    }).catch(() => "");

    if (!outcome)
    {
        return false;
    }

    if (outcome.startsWith("orphaned-backdrop"))
    {
        orphanedBackdropRecoveries.push(`[${deviceLabel}] ${outcome}`);
        console.log(`    (device ${deviceLabel}: cleared an ORPHANED dialog backdrop — ${outcome})`);
    }
    else
    {
        trace(`    (device ${deviceLabel}: ${outcome})`);
    }

    await sleep(BrowserSuiteHelpers.SETTLE_MS);
    return true;
}

/**
 * Closes any context menu that is still on screen.
 *
 * A case that failed part-way through a menu interaction leaves the menu open,
 * and an open menu's backdrop absorbs the NEXT case's clicks — including the
 * one on the sync pill, which then reports "sync did not complete" when in
 * truth no sync was ever asked for. Recovering here keeps one failure from
 * cascading into a run's worth of misleading ones.
 */
async function closeAnyContextMenu(page)
{
    const bMenuOpen = await page.evaluate(() =>
        Array.from(document.querySelectorAll("deck-options-context-menu, card-options-context-menu, home-page-context-menu"))
            .some(element => element.getClientRects().length > 0)).catch(() => false);

    if (!bMenuOpen)
    {
        return false;
    }

    await page.keyboard.press("Escape").catch(() => {});
    await sleep(300);

    const bStillOpen = await page.evaluate(() =>
        Array.from(document.querySelectorAll("deck-options-context-menu, card-options-context-menu, home-page-context-menu"))
            .some(element => element.getClientRects().length > 0)).catch(() => false);

    if (bStillOpen)
    {
        // Escape is not wired on every menu; a click on empty page chrome is.
        await page.mouse.click(8, Math.round(BrowserSuiteHelpers.VIEWPORT.height / 2)).catch(() => {});
        await sleep(300);
    }

    return true;
}

/**
 * Opens a deck's options menu and does not return until the menu is really on
 * screen, retrying the press if it was not.
 *
 * BrowserSuiteHelpers.openDeckOptionsMenu aims carefully but cannot know whether
 * the event was honoured — a sync pull landing in the few hundred milliseconds
 * after the press absorbs it silently, and the failure then surfaces one step
 * later as "Browse did nothing".
 */
async function openDeckOptionsMenuReliably(page, deckShortName)
{
    const tileSelector = await waitUntil(page, BrowserSuiteHelpers.deckTileSelectorInPage, deckShortName,
        `the deck tile for "${deckShortName}"`, 30000);

    await BrowserSuiteHelpers.clickUntil(page, `${tileSelector} .deck-options-button`, () =>
    {
        const bOpen = Array.from(document.querySelectorAll("deck-options-context-menu"))
            .some(element => element.getClientRects().length > 0);
        return bOpen ? "open" : null;
    }, null, "the deck options menu");

    return tileSelector;
}

/**
 * Presses one of the deck options menu's buttons and waits for the page it is
 * supposed to open, retrying the press if the menu is still up afterwards.
 */
async function chooseDeckOptionAndWaitForPage(page, buttonClassName, expectedPageTag)
{
    await BrowserSuiteHelpers.clickUntil(page, `deck-options-context-menu ${buttonClassName}`, (pageTag) =>
    {
        const bOnTargetPage = Array.from(document.querySelectorAll(pageTag))
            .some(element => element.getClientRects().length > 0);
        return bOnTargetPage ? "opened" : null;
    }, expectedPageTag, `the ${expectedPageTag}`);

    await waitForPage(page, expectedPageTag);
}

async function waitForDeckTile(page, shortName, description)
{
    return waitUntil(page, BrowserSuiteHelpers.deckTileSelectorInPage, shortName,
        description || `the deck tile "${shortName}"`, 30000);
}

/**
 * Creates a deck through the real UI and returns once it is on Home.
 *
 * The + tile has TWO legitimate destinations, decided by
 * DeckCreationChoiceAvailability: a signed-in, online user gets the
 * create/import/buy chooser, while an anonymous or offline one is sent straight
 * to the blank deck editor. Immediately after boot the session user may not be
 * populated yet, so the very first creation of a run can take the second branch
 * even though later ones take the first. Waiting for one specific selector
 * therefore fails intermittently on the first case and passes on every case
 * after it — so accept whichever branch the app actually took.
 */
async function createDeckThroughUi(page, deckName, deckShortName)
{
    await clickVisible(page, "new-deck-tile");

    const branch = await waitUntil(page, () =>
    {
        const bChooserUp = Array.from(document.querySelectorAll(".create-deck-choice-create"))
            .some(element => element.getClientRects().length > 0);
        if (bChooserUp)
        {
            return "chooser";
        }
        const bEditorUp = Array.from(document.querySelectorAll("deck-editor-page"))
            .some(element => element.getClientRects().length > 0);
        return bEditorUp ? "editor" : null;
    }, null, "the create-deck chooser or the deck editor to open", 30000);

    if (branch === "chooser")
    {
        await clickVisible(page, ".create-deck-choice-create");
    }

    await waitForPage(page, "deck-editor-page");
    await typeIntoInput(page, ".deck-name-input", deckName);
    await typeIntoInput(page, ".deck-short-name-input", deckShortName);
    await clickVisible(page, ".deck-save-input");
    await waitForPage(page, "home-page");
    await waitForDeckTile(page, deckShortName, `the new deck's tile "${deckShortName}" on Home`);

    return branch;
}

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
    await sleep(BrowserSuiteHelpers.SETTLE_MS);
}

/**
 * Opens the fixture deck's card browser and returns how many rows it lists.
 * BrowserPage renders one <card-list-item> per card with no virtualisation, so
 * the row count IS the client's card count for that deck — a real read of what
 * the user can see, not of app state.
 */
async function countCardsInDeckBrowser(device, deckShortName, expectedAtLeast)
{
    const page = device.page;

    try
    {
        await BrowserSuiteHelpers.returnToHome(page);
        await openDeckOptionsMenuReliably(page, deckShortName);

        // Browse does NOT go straight to the card browser: it closes the menu
        // and raises an entity picker (Cards / Study Materials / Mock Tests),
        // and only the picker's choice navigates. Waiting on browser-page
        // straight after the Browse press therefore waits forever with the
        // picker sitting on screen — and because the press has already removed
        // the menu, the retry cannot find the button either, which surfaces as
        // the misleading "no .browse-button" rather than "you skipped a step".
        await BrowserSuiteHelpers.clickUntil(page, "deck-options-context-menu .browse-button", () =>
        {
            const bPickerUp = Array.from(document.querySelectorAll(".entity-picker-card-button"))
                .some(element => element.getClientRects().length > 0);
            return bPickerUp ? "open" : null;
        }, null, "the Browse entity picker");

        await BrowserSuiteHelpers.clickUntil(page, ".entity-picker-card-button", () =>
        {
            const bBrowserUp = Array.from(document.querySelectorAll("browser-page"))
                .some(element => element.getClientRects().length > 0);
            return bBrowserUp ? "open" : null;
        }, null, "the card browser");

        await waitForPage(page, "browser-page");

        // The list is rebuilt from the deck on mount; give it until it stops
        // growing rather than reading a half-rendered list.
        if (expectedAtLeast > 0)
        {
            await waitUntil(page, (minimumCount) => document.querySelectorAll("card-list-item").length >= minimumCount,
                expectedAtLeast, `at least ${expectedAtLeast} card row(s) in the browser`, 60000).catch(() => {});
        }

        return page.evaluate(() => document.querySelectorAll("card-list-item").length);
    }
    finally
    {
        // Always hand the device back on Home, even when the count above threw.
        // Leaving it on the browser page (or with the menu open) is what turns
        // one failed case into every later case on that device failing too.
        await closeAnyContextMenu(page).catch(() => {});
        await BrowserSuiteHelpers.returnToHome(page).catch(() => {});
    }
}

/**
 * The apply-phase progress series for one drain, in order.
 *
 * Push-phase events are excluded: they report the size of the local upload, a
 * different series entirely, and mixing the two would make a large push look
 * like a growing pull total.
 */
function applyPhaseProgressSeries(recorder)
{
    return (recorder.entityProgress || []).filter(entry => entry.phase === "apply" && entry.total > 0);
}

// ── The run ────────────────────────────────────────────────────────────────

(async () =>
{
    const cases = [];
    const scriptErrors = [];
    let caseNumber = 0;
    let environmentBlockedReason = "";

    let browser = null;
    const devices = [];
    const probe = new SyncDatabaseProbe(TEST_ACCOUNT_ID);

    const watchdogTimeoutId = setTimeout(async () =>
    {
        const minutes = Math.round(SUITE_TIMEOUT_MS / 60000);
        const note = `The suite exceeded its ${minutes}-minute ceiling and was aborted. `
            + `${cases.length} case(s) had reported before it stalled; the case after the last one listed is where it hung.`;
        console.log(`\n  ABORT — ${note}`);

        cases.push({ name: "99. Suite completed within its time limit", status: "FAIL", detail: note });
        const abortedPassed = cases.filter(entry => entry.status === "PASS").length;
        writeResult({
            service: "Main", category: CATEGORY, status: "FAIL",
            passed: abortedPassed,
            failed: cases.filter(entry => entry.status === "FAIL").length,
            skipped: cases.filter(entry => entry.status === "SKIPPED").length,
            total: cases.length,
            coverage: { kind: "flows", label: "Sync behaviours proven", percent: null, detail: note },
            cases, notes: note,
        });

        // Best effort — a hung page can refuse to close, so never wait on it.
        if (browser)
        {
            await Promise.race([browser.close().catch(() => {}), sleep(5000)]);
        }
        await probe.close().catch(() => {});
        process.exit(1);
    }, SUITE_TIMEOUT_MS);

    // Carried between cases.
    let fixtureDeckId = "";
    // Ids the suite deletes THROUGH THE UI. Their rows are gone by cleanup
    // time, so the fixture sweep cannot discover their tombstones — they have
    // to be remembered here or they accumulate on the account run after run.
    const fixtureDeletedEntityIds = [];
    let drainRecorder = null;
    let drainCountsBefore = null;
    let deckTombstonesBeforeDrain = 0;

    const runCase = async (name, caseFunction) =>
    {
        caseNumber += 1;
        const label = `${String(caseNumber).padStart(2, "0")}. ${name}`;

        if (environmentBlockedReason)
        {
            cases.push({ name: label, status: "SKIPPED", detail: environmentBlockedReason });
            console.log(`  SKIP ${label} — ${environmentBlockedReason}`);
            return;
        }

        try
        {
            // Clear anything modal that a previous case (or autoplay) left over
            // every device, not just the one the case starts on — an overlay on
            // Device B absorbs B's clicks just as silently as A's.
            for (const device of devices)
            {
                await dismissTutorialOverlayIfPresent(device.page).catch(() => {});
                await BrowserSuiteHelpers.dismissBadgeCelebrationIfPresent(device.page).catch(() => {});
                await closeAnyContextMenu(device.page).catch(() => {});
                await clearBlockingChromeIfPresent(device.page, device.label).catch(() => {});
                await BrowserSuiteHelpers.returnToHome(device.page).catch(() => {});
            }

            const detail = await caseFunction();
            cases.push({ name: label, status: "PASS", detail: detail || "" });
            console.log(`  PASS ${label}${detail ? ` — ${detail}` : ""}`);
        }
        catch (caseError)
        {
            if (caseError instanceof EnvironmentUnavailableError)
            {
                // An environment that cannot run the test has not proved the
                // app wrong; every later case depends on this one's state, so
                // block the rest rather than cascade misleading failures.
                environmentBlockedReason = caseError.message;
                cases.push({ name: label, status: "SKIPPED", detail: caseError.message });
                console.log(`  SKIP ${label} — ${caseError.message}`);
                return;
            }

            // Capture EVERY device, not just the first. A cross-device case
            // fails on whichever device was wrong, and a screenshot of the
            // healthy one is worse than none — it sends you looking in the
            // wrong browser entirely.
            const diagnosticPaths = [];
            for (const device of devices)
            {
                const capturedPath = await BrowserSuiteHelpers
                    .captureFailureDiagnostics(device.page, RESULT_FILE, `${caseNumber}-device-${device.label}`, caseError.message)
                    .catch(() => "");
                if (capturedPath)
                {
                    diagnosticPaths.push(`${device.label}:${capturedPath}`);
                }
            }
            const diagnostics = diagnosticPaths.join(" ");
            cases.push({ name: label, status: "FAIL", detail: `${caseError.message}${diagnostics ? ` (diagnostics: ${diagnostics})` : ""}` });
            console.log(`  FAIL ${label} — ${caseError.message}`);
        }
    };

    console.log(`Main ${CATEGORY}: starting against ${BASE_URL} (account ${TEST_ACCOUNT_ID})`);

    try
    {
        const bConnected = await probe.connect(REPOSITORY_ROOT);
        if (!bConnected)
        {
            skip("MongoDB is not reachable with Dock/.env's configuration; every sync assertion needs the server's own state.");
            process.exit(0);
        }

        browser = await puppeteer.launch({
            headless: RUN_HEADFUL ? false : "new",
            slowMo: SLOW_MO_MS,
            defaultViewport: BrowserSuiteHelpers.VIEWPORT,
            args: ["--no-sandbox", "--disable-setuid-sandbox", `--window-size=${BrowserSuiteHelpers.VIEWPORT.width},${BrowserSuiteHelpers.VIEWPORT.height}`],
        });

        // Leftovers from an interrupted previous run would be counted as this
        // run's own rows and quietly shift every count assertion.
        const preSweep = await probe.deleteFixtureData(FIXTURE_PREFIX);
        if (preSweep.removedRowCount > 0)
        {
            trace(`  (pre-sweep removed ${preSweep.removedRowCount} leftover fixture row(s))`);
        }

        // The sync lock is per-account and survives a browser that closed
        // mid-cycle for the whole of its server-side TTL. On a deploy the
        // critical-flow suite runs immediately before this one on the SAME
        // account, so a cycle it interrupted leaves the lock held and every
        // push here blocks on it — the suite then reports sync failures that
        // are really the previous suite's leftover state. Release it once,
        // here, before any assertion runs. This cannot mask a lock defect
        // during the run: it happens before the first case, and case 16 still
        // sets up and asserts real two-device lock behaviour itself.
        const forceUnlockResponse = await fetch(`${BASE_URL}/Sync/ForceUnlock`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json", "Cookie": `sessionId=${SESSION_COOKIE}` },
            body: JSON.stringify({}),
        }).catch(() => null);

        if (forceUnlockResponse && forceUnlockResponse.ok)
        {
            const forceUnlockResult = await forceUnlockResponse.json().catch(() => ({}));
            if (forceUnlockResult.released)
            {
                trace(`  (pre-sweep released a stale sync lock held by device ${forceUnlockResult.previousHolderDeviceId})`);
            }
        }

        // ── Device A: boot and first sync ───────────────────────────────────

        await runCase("Device A boots and its first sync settles without error", async () =>
        {
            const deviceA = await openDevice(browser, "A", scriptErrors);
            devices.push(deviceA);

            try
            {
                await bootDevice(deviceA);
            }
            catch (bootError)
            {
                throw new EnvironmentUnavailableError(
                    `Device A could not reach a settled home page (${bootError.message}). `
                    + "Check that Dock is serving the BUILT app and that TEST_SESSION_COOKIE is a live, terms-accepted session.");
            }

            const recorder = await readSyncRecorder(deviceA.page);
            if (!recorder)
            {
                throw new Error("The sync event recorder was never installed — the page did not run the injected script.");
            }
            if (recorder.failed.length > 0)
            {
                throw new Error(`The boot sync reported failure: ${recorder.failed.join(" | ")}`);
            }

            return `booted; ${recorder.started} sync start(s), ${recorder.completed} completion(s), no failures`;
        });

        await runCase("Device A's root grid matches the deck count the server holds", async () =>
        {
            const deviceA = devices[0];
            const serverRoot = await probe.countRootLevelDecks();
            if (!serverRoot.rootDeckId)
            {
                throw new EnvironmentUnavailableError(
                    "The account has no root deck on the server yet — seed_browser_test_account.js has not been run against this database.");
            }

            const visibleTileCount = await deviceA.page.evaluate(() =>
                Array.from(document.querySelectorAll("deck-tile")).filter(tile => tile.getClientRects().length > 0).length);

            if (visibleTileCount !== serverRoot.childCount)
            {
                throw new Error(`The grid shows ${visibleTileCount} deck tile(s) but the server holds `
                    + `${serverRoot.childCount} root-level deck(s) — the first sync did not deliver the library faithfully.`);
            }

            return `${visibleTileCount} tile(s) on screen == ${serverRoot.childCount} root deck(s) on the server`;
        });

        // ── Push ────────────────────────────────────────────────────────────

        await runCase("A deck created on Device A reaches the server", async () =>
        {
            const deviceA = devices[0];
            const page = deviceA.page;

            await createDeckThroughUi(page, FIXTURE_DECK_NAME, FIXTURE_DECK_SHORT_NAME);

            await syncNowAndWait(deviceA);

            const storedDeck = await probe.findDeckByShortName(FIXTURE_DECK_SHORT_NAME);
            if (!storedDeck)
            {
                throw new Error(`The deck "${FIXTURE_DECK_SHORT_NAME}" is on screen but the server has no row for it — the push never landed.`);
            }
            fixtureDeckId = storedDeck.data.id;

            return `server row present (id ${fixtureDeckId})`;
        });

        await runCase("A card authored on Device A reaches the server", async () =>
        {
            const deviceA = devices[0];
            const page = deviceA.page;

            await openDeckOptionsMenuReliably(page, FIXTURE_DECK_SHORT_NAME);
            await BrowserSuiteHelpers.clickUntil(page, "deck-options-context-menu .add-button", () =>
            {
                const bPickerUp = Array.from(document.querySelectorAll(".entity-picker-card-button"))
                    .some(element => element.getClientRects().length > 0);
                return bPickerUp ? "open" : null;
            }, null, "the entity picker");
            await clickVisible(page, ".entity-picker-card-button");
            await waitForPage(page, "card-editor-page");
            await typeIntoRichTextEditor(page, ".question-editor", FIXTURE_CARD_QUESTION);
            await typeIntoRichTextEditor(page, ".answer-editor", FIXTURE_CARD_ANSWER);
            await clickVisible(page, "card-editor-page .save-button");
            await sleep(BrowserSuiteHelpers.SETTLE_MS);
            await BrowserSuiteHelpers.returnToHome(page);

            await syncNowAndWait(deviceA);

            const serverCardCount = await probe.countCardsInDeck(fixtureDeckId);
            if (serverCardCount < 1)
            {
                throw new Error("The card was saved on screen but the server holds no card for the fixture deck — the push never landed.");
            }

            return `${serverCardCount} card row(s) on the server`;
        });

        // ── Cross-device pull ───────────────────────────────────────────────

        await runCase("Device B boots fresh and receives Device A's deck", async () =>
        {
            const deviceB = await openDevice(browser, "B", scriptErrors);
            devices.push(deviceB);
            await bootDevice(deviceB);

            await waitForDeckTile(deviceB.page, FIXTURE_DECK_SHORT_NAME,
                "Device A's deck to appear on a completely fresh Device B");

            return "the deck created on A is on screen on B after its first sync";
        });

        await runCase("Device B lists the card Device A authored", async () =>
        {
            const deviceB = devices[1];
            const listedCount = await countCardsInDeckBrowser(deviceB, FIXTURE_DECK_SHORT_NAME, 1);
            if (listedCount < 1)
            {
                throw new Error("Device B shows the deck but its card browser is empty — the deck synced without its cards.");
            }
            return `${listedCount} card row(s) listed on B`;
        });

        await runCase("A rename on Device A reaches Device B", async () =>
        {
            const deviceA = devices[0];
            const deviceB = devices[1];

            await BrowserSuiteHelpers.returnToHome(deviceA.page);
            await openDeckOptionsMenuReliably(deviceA.page, FIXTURE_DECK_SHORT_NAME);
            await chooseDeckOptionAndWaitForPage(deviceA.page, ".edit-button", "deck-editor-page");
            await typeIntoInput(deviceA.page, ".deck-name-input", FIXTURE_DECK_RENAMED);
            await clickVisible(deviceA.page, ".deck-save-input");
            await waitForPage(deviceA.page, "home-page");

            await syncNowAndWait(deviceA);
            await syncNowAndWait(deviceB);

            // The tile shows the SHORT name, so read the propagated long name
            // through B's own editor — the same place a user would look.
            await BrowserSuiteHelpers.returnToHome(deviceB.page);
            await openDeckOptionsMenuReliably(deviceB.page, FIXTURE_DECK_SHORT_NAME);
            await chooseDeckOptionAndWaitForPage(deviceB.page, ".edit-button", "deck-editor-page");
            const nameOnDeviceB = await deviceB.page.evaluate(() =>
            {
                const input = Array.from(document.querySelectorAll(".deck-name-input"))
                    .find(candidate => candidate.getClientRects().length > 0);
                return input ? input.value : "";
            });
            await clickVisible(deviceB.page, ".deck-cancel-input");
            await dismissAlert(deviceB.page);
            await waitForPage(deviceB.page, "home-page");

            if (nameOnDeviceB !== FIXTURE_DECK_RENAMED)
            {
                throw new Error(`Device B still shows "${nameOnDeviceB}" after A renamed the deck to "${FIXTURE_DECK_RENAMED}".`);
            }

            return `B reads "${nameOnDeviceB}"`;
        });

        await runCase("A deletion on Device A reaches Device B and is tombstoned server-side", async () =>
        {
            const deviceA = devices[0];
            const deviceB = devices[1];

            // Build a throwaway sub-deck to delete, so the fixture deck the
            // later drain cases depend on survives.
            await BrowserSuiteHelpers.returnToHome(deviceA.page);
            await createDeckThroughUi(deviceA.page, FIXTURE_SUB_DECK_NAME, FIXTURE_SUB_DECK_SHORT_NAME);

            await syncNowAndWait(deviceA);
            await syncNowAndWait(deviceB);
            await waitForDeckTile(deviceB.page, FIXTURE_SUB_DECK_SHORT_NAME, "the throwaway deck to arrive on B");

            // Remember the id before it is deleted — afterwards there is no row
            // left to look it up from, and its tombstone would outlive the run.
            const subDeckBeforeDeletion = await probe.findDeckByShortName(FIXTURE_SUB_DECK_SHORT_NAME);
            if (subDeckBeforeDeletion)
            {
                fixtureDeletedEntityIds.push(subDeckBeforeDeletion.data.id);
            }

            await openDeckOptionsMenuReliably(deviceA.page, FIXTURE_SUB_DECK_SHORT_NAME);
            await chooseDeckOptionAndWaitForPage(deviceA.page, ".edit-button", "deck-editor-page");
            await clickVisible(deviceA.page, ".deck-delete-input");
            await clickVisible(deviceA.page, "dialog-box .ok-button");
            await waitForPage(deviceA.page, "home-page");

            await syncNowAndWait(deviceA);

            const storedDeck = await probe.findDeckByShortName(FIXTURE_SUB_DECK_SHORT_NAME);
            if (storedDeck)
            {
                throw new Error("The deck was deleted on A but the server still holds its row — the deletion never pushed.");
            }

            await syncNowAndWait(deviceB);
            await waitUntil(deviceB.page, (shortName) =>
            {
                const tiles = Array.from(document.querySelectorAll("deck-tile"))
                    .filter(tile => tile.getClientRects().length > 0);
                const match = tiles.find(tile =>
                {
                    const nameElement = tile.querySelector(".deck-name-container");
                    return nameElement && nameElement.textContent.trim() === shortName;
                });
                return match ? null : "gone";
            }, FIXTURE_SUB_DECK_SHORT_NAME, "the deleted deck to disappear from Device B", 30000);

            return "row removed server-side and the tile is gone from B";
        });

        // ── Durability ──────────────────────────────────────────────────────

        await runCase("Reloading Device A preserves the library rather than re-pulling an empty one", async () =>
        {
            const deviceA = devices[0];

            await deviceA.page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
            await waitForPage(deviceA.page, "home-page");
            await BrowserSuiteHelpers.waitForSyncToSettle(deviceA.page);
            await waitForDeckTile(deviceA.page, FIXTURE_DECK_SHORT_NAME, "the fixture deck after a reload");

            const recorder = await readSyncRecorder(deviceA.page);
            if (recorder && recorder.failed.length > 0)
            {
                throw new Error(`The post-reload sync failed: ${recorder.failed.join(" | ")}`);
            }

            const serverDeck = await probe.findDeckByShortName(FIXTURE_DECK_SHORT_NAME);
            if (!serverDeck)
            {
                throw new Error("The reload left the deck on screen but the server row has gone — a reload must never delete data.");
            }

            return "library intact on screen and on the server after a reload";
        });

        // ── The chunked drain ───────────────────────────────────────────────

        await runCase(`Seed ${DRAIN_CARD_COUNT} server-side cards so the next pull must chunk`, async () =>
        {
            if (DRAIN_CARD_COUNT <= SERVER_MAX_PULL_PER_COLLECTION)
            {
                throw new Error(`DRAIN_CARD_COUNT (${DRAIN_CARD_COUNT}) is not above the server's `
                    + `MAX_PULL_PER_COLLECTION (${SERVER_MAX_PULL_PER_COLLECTION}); the pull would fit in one cycle and the drain cases would prove nothing.`);
            }

            const templateCard = await probe.findAnyCardInDeck(fixtureDeckId);
            if (!templateCard)
            {
                throw new Error("No card to clone — the fixture deck has no server-side card row.");
            }

            const seedResult = await probe.cloneCardsIntoDeck(templateCard, DRAIN_CARD_COUNT, `${FIXTURE_PREFIX}${RUN_TAG}`);

            // Push the WHOLE account back above Device B's cursor, which is the
            // state a device that has been away arrives in — and the state that
            // makes several collections, not just cards, land in one drain.
            const bumpResult = await probe.bumpAllServerUpdatedAt();

            drainCountsBefore = await probe.readEntityCounts();
            deckTombstonesBeforeDrain = await probe.countDeletionTombstones(SyncDatabaseProbe.ENTITY_TYPE_DECK);

            return `${seedResult.insertedCount} card(s) seeded; ${bumpResult.modifiedCount} row(s) moved above the cursor `
                + `(${drainCountsBefore.total} entities total)`;
        });

        await runCase("The chunked drain runs to completion and delivers every card", async () =>
        {
            const deviceB = devices[1];

            drainRecorder = await syncNowAndWait(deviceB, DRAIN_TIMEOUT_MS);

            const applySeries = applyPhaseProgressSeries(drainRecorder);
            if (applySeries.length === 0)
            {
                throw new Error("The pull reported no apply-phase progress at all — it did not chunk, so this case and the three after it "
                    + "would prove nothing. Raise DRAIN_CARD_COUNT above the server's per-collection cap.");
            }

            const serverCardCount = await probe.countCardsInDeck(fixtureDeckId);
            const listedCount = await countCardsInDeckBrowser(deviceB, FIXTURE_DECK_SHORT_NAME, serverCardCount);

            if (listedCount !== serverCardCount)
            {
                throw new Error(`After the drain Device B lists ${listedCount} card(s) but the server holds ${serverCardCount} `
                    + "— the drain dropped rows.");
            }

            return `${listedCount} card(s) on B == ${serverCardCount} on the server, across ${applySeries.length} progress update(s)`;
        });

        await runCase("The drain's \"X / Y items\" total never grows", async () =>
        {
            // THE REGRESSION THIS SUITE EXISTS FOR.
            //
            // Every collection is pulled with an open-ended
            // `serverUpdatedAt > lastSync`, but a chunked pull hands back the
            // SMALLEST overflow watermark as the next cursor. Rows above that
            // cursor in a collection that did not overflow were therefore
            // re-sent on every cycle, and counted a second time in
            // `remainingEntityCount` on top — so the denominator the user
            // watches CLIMBED on every round trip instead of counting down. A
            // returning device could sit there indefinitely while the number
            // got bigger, which is exactly what it looks like from the outside:
            // sync is broken.
            if (!drainRecorder)
            {
                throw new Error("No drain was recorded — the preceding case did not run.");
            }

            const applySeries = applyPhaseProgressSeries(drainRecorder);
            if (applySeries.length === 0)
            {
                throw new Error("No apply-phase progress was recorded, so the total could not be checked.");
            }

            let largestIncrease = 0;
            let increaseDetail = "";
            for (let entryIndex = 1; entryIndex < applySeries.length; entryIndex++)
            {
                const increase = applySeries[entryIndex].total - applySeries[entryIndex - 1].total;
                if (increase > largestIncrease)
                {
                    largestIncrease = increase;
                    increaseDetail = `${applySeries[entryIndex - 1].total} -> ${applySeries[entryIndex].total}`;
                }
            }

            if (largestIncrease > 0)
            {
                throw new Error(`The progress total GREW during the drain (${increaseDetail}, +${largestIncrease}). `
                    + "Entities are being delivered more than once and counted as remaining as well as delivered.");
            }

            const totals = applySeries.map(entry => entry.total);
            return `total held at ${totals[0]} across ${applySeries.length} update(s) (min ${Math.min(...totals)}, max ${Math.max(...totals)})`;
        });

        await runCase("The drain finishes on \"X / X\" with the blocking modal cleared", async () =>
        {
            const deviceB = devices[1];

            if (!drainRecorder)
            {
                throw new Error("No drain was recorded — an earlier case did not run.");
            }

            const applySeries = applyPhaseProgressSeries(drainRecorder);
            const finalEntry = applySeries[applySeries.length - 1];

            if (!finalEntry || finalEntry.processed !== finalEntry.total)
            {
                throw new Error(`The drain's last progress update was ${finalEntry ? `${finalEntry.processed} / ${finalEntry.total}` : "(none)"} `
                    + "— it never reached a completed count, so the user is left watching an unfinished bar.");
            }

            const bModalUp = await BrowserSuiteHelpers.syncModalIsUp(deviceB.page);
            if (bModalUp)
            {
                throw new Error("The sync blocking modal is still on screen after the drain completed.");
            }

            return `finished on ${finalEntry.processed} / ${finalEntry.total}; modal cleared`;
        });

        await runCase("The drain deleted nothing — no deck was tombstoned while chunks were still pending", async () =>
        {
            // A deck whose parent has not arrived yet used to be treated as a
            // genuine orphan and queued as a DELETION tombstone, which the
            // server-side cascade then turned into a real deletion of the deck
            // and everything under it. Mid-drain that parent may simply belong
            // to a later chunk, so the tombstone destroyed live data.
            if (!drainCountsBefore)
            {
                throw new Error("No pre-drain counts were taken — an earlier case did not run.");
            }

            const countsAfter = await probe.readEntityCounts();
            const deckTombstonesAfter = await probe.countDeletionTombstones(SyncDatabaseProbe.ENTITY_TYPE_DECK);

            if (countsAfter.decks < drainCountsBefore.decks)
            {
                throw new Error(`The account lost ${drainCountsBefore.decks - countsAfter.decks} deck(s) across the drain `
                    + `(${drainCountsBefore.decks} -> ${countsAfter.decks}).`);
            }

            if (deckTombstonesAfter > deckTombstonesBeforeDrain)
            {
                throw new Error(`${deckTombstonesAfter - deckTombstonesBeforeDrain} deck deletion tombstone(s) were queued during the drain `
                    + "— an unresolved parent was mistaken for an orphan.");
            }

            if (countsAfter.cards < drainCountsBefore.cards)
            {
                throw new Error(`The account lost ${drainCountsBefore.cards - countsAfter.cards} card(s) across the drain.`);
            }

            return `decks ${drainCountsBefore.decks} -> ${countsAfter.decks}, cards ${drainCountsBefore.cards} -> ${countsAfter.cards}, `
                + `no new deck tombstones`;
        });

        // ── A permanently unresolvable parent is reparented, never deleted ──

        let unresolvableParentDeckId = "";
        let unresolvableParentDeckShortName = "";
        let unresolvableParentTombstonesBefore = 0;

        await runCase("Seed a deck whose parent will never resolve, simulating a withheld or missing parent", async () =>
        {
            // A deck's parent can fail to arrive for reasons that have nothing to
            // do with drain chunking — most commonly a paid deck the account has
            // no license for, which the server withholds from every pull while
            // still counting it toward the total (see Sync.js's
            // resolvePaidContentKey). To a syncing client this looks identical to
            // a parent id that simply does not exist, which is the simplest
            // faithful way to reproduce it here without standing up a full
            // paid-deck/license fixture.
            const fixtureDeck = await probe.findDeckById(fixtureDeckId);
            if (!fixtureDeck)
            {
                throw new Error("The fixture deck's own server row is missing — cannot clone a template from it.");
            }

            unresolvableParentTombstonesBefore = await probe.countDeletionTombstones(SyncDatabaseProbe.ENTITY_TYPE_DECK);

            const seeded = await probe.cloneDeckWithParent(fixtureDeck, `nonexistent-parent-${RUN_TAG}`, "UnresolvedParent", FIXTURE_PREFIX);
            unresolvableParentDeckId = seeded.deckId;
            unresolvableParentDeckShortName = seeded.shortName;

            return `seeded deck ${seeded.shortName} with parent nonexistent-parent-${RUN_TAG}`;
        });

        await runCase("An established device's incremental sync attaches the unresolvable-parent deck to root instead of deleting it", async () =>
        {
            // THE REGRESSION THIS CASE EXISTS FOR.
            //
            // A fresh device's bulk-snapshot pull already attached an
            // unresolved-parent deck to root safely. An established device's
            // INCREMENTAL pull instead treated it as a genuine orphan on the
            // drain's final cycle, queued a deletion tombstone, and the
            // server-side cascade turned that into a real delete of the deck
            // (and everything under it) for every device. Device B already has
            // a full local library from the cases above, so this sync exercises
            // exactly that incremental path (SyncApplier#applyDeckChangesInOrder),
            // never the fresh-device bulk-snapshot path.
            const deviceB = devices[1];

            await syncNowAndWait(deviceB);

            const serverDeckAfter = await probe.findDeckById(unresolvableParentDeckId);
            if (!serverDeckAfter)
            {
                throw new Error("The deck with an unresolvable parent was deleted server-side — an unresolved parent was mistaken for an orphan and cascade-deleted.");
            }

            const tombstonesAfter = await probe.countDeletionTombstones(SyncDatabaseProbe.ENTITY_TYPE_DECK);
            if (tombstonesAfter > unresolvableParentTombstonesBefore)
            {
                throw new Error(`${tombstonesAfter - unresolvableParentTombstonesBefore} deck deletion tombstone(s) were queued for a deck whose parent simply never resolved.`);
            }

            await BrowserSuiteHelpers.returnToHome(deviceB.page);
            await waitForDeckTile(deviceB.page, unresolvableParentDeckShortName, "the unresolvable-parent deck attached to root");

            return "deck survived server-side, no new deletion tombstone, and it is visible on Home (attached to root)";
        });

        // ── Bulk snapshot at scale ──────────────────────────────────────────

        await runCase("A brand-new device receives the whole multi-hundred-entity library", async () =>
        {
            const deviceC = await openDevice(browser, "C", scriptErrors);
            devices.push(deviceC);
            await bootDevice(deviceC);

            await waitForDeckTile(deviceC.page, FIXTURE_DECK_SHORT_NAME, "the fixture deck on a brand-new device");

            const serverCardCount = await probe.countCardsInDeck(fixtureDeckId);
            const listedCount = await countCardsInDeckBrowser(deviceC, FIXTURE_DECK_SHORT_NAME, serverCardCount);

            if (listedCount !== serverCardCount)
            {
                throw new Error(`A fresh device lists ${listedCount} card(s) but the server holds ${serverCardCount} `
                    + "— the first-sync path did not deliver the full library.");
            }

            const serverRoot = await probe.countRootLevelDecks();
            const visibleTileCount = await deviceC.page.evaluate(() =>
                Array.from(document.querySelectorAll("deck-tile")).filter(tile => tile.getClientRects().length > 0).length);
            if (visibleTileCount !== serverRoot.childCount)
            {
                throw new Error(`A fresh device shows ${visibleTileCount} root tile(s) against ${serverRoot.childCount} on the server.`);
            }

            return `${listedCount} card(s) and ${visibleTileCount} root deck(s), both matching the server`;
        });

        // ── Locking ─────────────────────────────────────────────────────────

        await runCase("Two devices sync in turn without either being blocked on the lock", async () =>
        {
            const deviceA = devices[0];
            const deviceB = devices[1];

            const recorderA = await syncNowAndWait(deviceA);
            const recorderB = await syncNowAndWait(deviceB);

            if (recorderA.lockBlocked > 0 || recorderB.lockBlocked > 0)
            {
                throw new Error(`A sync was refused the lock (A: ${recorderA.lockBlocked}, B: ${recorderB.lockBlocked}) `
                    + "— the previous cycle did not release it.");
            }

            return "both cycles acquired the lock and completed";
        });

        // ── Offline ─────────────────────────────────────────────────────────

        await runCase("An edit made offline is queued and reaches the server once back online", async () =>
        {
            const deviceA = devices[0];
            const page = deviceA.page;

            await BrowserSuiteHelpers.returnToHome(page);
            await page.setOfflineMode(true);

            try
            {
                await openDeckOptionsMenuReliably(page, FIXTURE_DECK_SHORT_NAME);
                await chooseDeckOptionAndWaitForPage(page, ".edit-button", "deck-editor-page");
                await typeIntoInput(page, ".deck-name-input", FIXTURE_OFFLINE_NAME);
                await clickVisible(page, ".deck-save-input");
                await waitForPage(page, "home-page");
                await sleep(5000);

                const storedWhileOffline = await probe.findDeckByShortName(FIXTURE_DECK_SHORT_NAME);
                if (storedWhileOffline && storedWhileOffline.data.name === FIXTURE_OFFLINE_NAME)
                {
                    throw new Error("The server already has the offline edit — the device was never actually offline, so this case proved nothing.");
                }
            }
            finally
            {
                await page.setOfflineMode(false);
            }

            await syncNowAndWait(deviceA);

            const storedAfterReconnect = await probe.findDeckByShortName(FIXTURE_DECK_SHORT_NAME);
            if (!storedAfterReconnect || storedAfterReconnect.data.name !== FIXTURE_OFFLINE_NAME)
            {
                throw new Error(`The offline edit never reached the server — it still reads `
                    + `"${storedAfterReconnect ? storedAfterReconnect.data.name : "(missing)"}" instead of "${FIXTURE_OFFLINE_NAME}".`);
            }

            return `queued while offline and pushed on reconnect as "${FIXTURE_OFFLINE_NAME}"`;
        });

        // ── Convergence ─────────────────────────────────────────────────────

        await runCase("Every device converges on the server's view once all have synced", async () =>
        {
            const serverDeck = await probe.findDeckByShortName(FIXTURE_DECK_SHORT_NAME);
            if (!serverDeck)
            {
                throw new Error("The fixture deck has gone from the server.");
            }

            const namesByDevice = [];
            for (const device of devices)
            {
                await syncNowAndWait(device);
                await BrowserSuiteHelpers.returnToHome(device.page);
                await openDeckOptionsMenuReliably(device.page, FIXTURE_DECK_SHORT_NAME);
                await chooseDeckOptionAndWaitForPage(device.page, ".edit-button", "deck-editor-page");
                const name = await device.page.evaluate(() =>
                {
                    const input = Array.from(document.querySelectorAll(".deck-name-input"))
                        .find(candidate => candidate.getClientRects().length > 0);
                    return input ? input.value : "";
                });
                await clickVisible(device.page, ".deck-cancel-input");
                await dismissAlert(device.page);
                await waitForPage(device.page, "home-page");
                namesByDevice.push(`${device.label}="${name}"`);

                if (name !== serverDeck.data.name)
                {
                    throw new Error(`Device ${device.label} reads "${name}" but the server holds "${serverDeck.data.name}" `
                        + "— the devices have not converged.");
                }
            }

            return `${namesByDevice.join(", ")}, all matching the server`;
        });

        // ── Whole-run error gate ────────────────────────────────────────────

        await runCase("No uncaught client script errors during the sync flows", async () =>
        {
            if (scriptErrors.length > 0)
            {
                throw new Error(`${scriptErrors.length} uncaught client error(s): ${scriptErrors.slice(0, 3).join(" | ")}`);
            }

            // An orphaned backdrop is invisible and absorbs every click, so to
            // a user the app has simply stopped responding with nothing on
            // screen to explain it. The harness recovers so the later cases
            // still run, but it must never pass silently.
            if (orphanedBackdropRecoveries.length > 0)
            {
                throw new Error(`${orphanedBackdropRecoveries.length} orphaned dialog backdrop(s) had to be cleared `
                    + `(${orphanedBackdropRecoveries.join(", ")}). A .dialog-backdrop left in the DOM with no dialog `
                    + "attached blocks every click while being invisible on screen.");
            }

            return "no pageerror events and no orphaned backdrops across every device";
        });
    }
    catch (fatalError)
    {
        cases.push({ name: "00. Suite harness", status: "FAIL", detail: `Unhandled: ${fatalError.message}` });
        console.log(`  FAIL 00. Suite harness — ${fatalError.message}`);
    }
    finally
    {
        clearTimeout(watchdogTimeoutId);

        if (!KEEP_FIXTURES && probe.getDatabase())
        {
            try
            {
                const sweep = await probe.deleteFixtureData(FIXTURE_PREFIX);
                const uiDeletedTombstones = await probe.deleteTombstonesFor(fixtureDeletedEntityIds);
                trace(`  (cleanup: removed ${sweep.removedRowCount} fixture row(s) and `
                    + `${sweep.removedTombstoneCount + uiDeletedTombstones} tombstone(s))`);
            }
            catch (cleanupError)
            {
                trace(`  (cleanup failed: ${cleanupError.message})`);
            }
        }

        if (browser)
        {
            await browser.close().catch(() => {});
        }

        await probe.close();
    }

    const passed = cases.filter(entry => entry.status === "PASS").length;
    const failed = cases.filter(entry => entry.status === "FAIL").length;
    const skipped = cases.filter(entry => entry.status === "SKIPPED").length;
    const percent = cases.length > 0 ? Math.round((passed / cases.length) * 100) : null;

    writeResult({
        service: "Main",
        category: CATEGORY,
        status: failed > 0 ? "FAIL" : (skipped > 0 || passed === 0 ? "SKIPPED" : "PASS"),
        passed, failed, skipped, total: cases.length,
        coverage: {
            kind: "flows",
            label: "Sync behaviours proven",
            percent,
            covered: passed,
            total: cases.length,
            detail: `${passed}/${cases.length} sync behaviours proved end to end across ${devices.length} independent device(s)`,
        },
        cases,
        notes: `${passed}/${cases.length} passed against ${BASE_URL} (account ${TEST_ACCOUNT_ID}).`,
    });

    console.log(`Main ${CATEGORY}: ${failed > 0 ? "FAIL" : (skipped > 0 ? "SKIPPED" : "PASS")} `
        + `(${passed} passed, ${failed} failed, ${skipped} skipped)`);
})();
