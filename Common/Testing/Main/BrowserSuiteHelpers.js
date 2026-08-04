// Shared Puppeteer driver helpers for CogniumLearn's browser suites.
//
// These are ported from run_critical_flow_tests.js, which grew them one hard-won
// failure at a time: aiming a click only after the target stops moving and
// actually owns its own centre pixel, waiting out the sync overlay rather than
// dismissing it, clearing inputs with real keystrokes because assigning .value
// fires no `input` event. A second suite that reimplemented any of that would
// reimplement the bugs too, so it lives here once.
//
// run_critical_flow_tests.js still carries its own copy and is deliberately
// left alone: it is the suite the production deploy gates on, and swapping its
// helper layer out is a change that has to be validated by a full green run,
// not smuggled in alongside a new feature. Migrating it is worthwhile follow-up
// work — do it on its own.
//
// Everything here drives the real rendered DOM. Nothing reaches into app
// internals beyond the opt-in window.__tutorialE2E seam the app itself exposes.

const fs = require("fs");
const path = require("path");

// Raised when the ENVIRONMENT cannot support a case — no Mongo, object storage
// unreachable, the Agent venv missing. Suites record these as SKIPPED, never
// FAILED: an environment that cannot run the test has not proved the app wrong.
class EnvironmentUnavailableError extends Error
{
}

class BrowserSuiteHelpers
{
    static VIEWPORT = { width: 1280, height: 900 };
    static DEFAULT_WAIT_MS = 12000;
    static POLL_INTERVAL_MS = 120;
    static SETTLE_MS = 350;
    static SYNC_SETTLE_TIMEOUT_MS = 120000;
    static AIM_TIMEOUT_MS = 90000;

    // Every page custom-element tag the app can mount. Needed because not every
    // page sets the `page` attribute on itself (study-page and deck-insights-page
    // do not), so an attribute scan alone silently reports "no page".
    static KNOWN_PAGE_TAGS =
    [
        "home-page", "login-page", "admin-panel-page", "settings-page",
        "cogniumlearn-about-page", "tutorials-page", "progress-page", "study-page",
        "card-editor-page", "study-material-editor-page", "deck-editor-page",
        "mock-test-editor-page", "mock-test-answer-key-page", "browser-page",
        "deck-insights-page", "automatic-generation-page", "activity-page",
        "paid-deck-library-page", "paid-deck-details-page", "paid-deck-browse-page",
    ];

    static #bVerbose = false;

    static configure(options)
    {
        BrowserSuiteHelpers.#bVerbose = Boolean(options && options.bVerbose);
    }

    static trace(message)
    {
        if (BrowserSuiteHelpers.#bVerbose)
        {
            console.log(message);
        }
    }

    static sleep(milliseconds)
    {
        return new Promise(resolve => setTimeout(resolve, milliseconds));
    }

    // -- Page-context probes --------------------------------------------------
    // These run INSIDE the browser, so they must be self-contained functions.

    static visiblePageTagInPage(knownTags)
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
    static visibleMatchExistsInPage(selector)
    {
        return Array.from(document.querySelectorAll(selector)).some(element => element.getClientRects().length > 0);
    }

    static deckTileSelectorInPage(shortName)
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

    static dialogTextInPage()
    {
        const dialogs = Array.from(document.querySelectorAll("dialog-box"))
            .filter(element => element.getClientRects().length > 0);
        return dialogs.map(element => (element.textContent || "").trim()).join(" | ");
    }

    // -- Driver helpers -------------------------------------------------------

    static async waitUntil(page, pageFunction, argument, description, timeoutMilliseconds = BrowserSuiteHelpers.DEFAULT_WAIT_MS)
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
            await BrowserSuiteHelpers.sleep(BrowserSuiteHelpers.POLL_INTERVAL_MS);
        }
        throw new Error(`Timed out waiting for ${description} (last value: ${JSON.stringify(lastValue)})`);
    }

    static async currentPageTag(page)
    {
        return page.evaluate(BrowserSuiteHelpers.visiblePageTagInPage, BrowserSuiteHelpers.KNOWN_PAGE_TAGS).catch(() => "");
    }

    static async waitForVisible(page, selector, description = null)
    {
        await BrowserSuiteHelpers.waitUntil(page, BrowserSuiteHelpers.visibleMatchExistsInPage, selector, description || `visible ${selector}`);
        await BrowserSuiteHelpers.sleep(BrowserSuiteHelpers.SETTLE_MS);
    }

    static async waitForPage(page, pageTagName)
    {
        const deadline = Date.now() + BrowserSuiteHelpers.DEFAULT_WAIT_MS;
        let current = "";
        while (Date.now() < deadline)
        {
            current = await BrowserSuiteHelpers.currentPageTag(page);
            if (current === pageTagName)
            {
                await BrowserSuiteHelpers.sleep(BrowserSuiteHelpers.SETTLE_MS);
                return;
            }
            await BrowserSuiteHelpers.sleep(BrowserSuiteHelpers.POLL_INTERVAL_MS);
        }
        throw new Error(`Timed out waiting for the ${pageTagName} to be on screen (currently on <${current || "nothing"}>)`);
    }

    // True while ANY sync overlay is covering the app. Detection is structural,
    // by component, not by prose: <sync-blocking-overlay> is not a dialog-box at
    // all, and SyncBlockingDialog's wording varies by caller. Both absorb
    // coordinate clicks, which is how a swallowed click becomes "the app ignored
    // the button" two steps later.
    static async syncModalIsUp(page)
    {
        return page.evaluate(() =>
        {
            const isOnScreen = element => element.getClientRects().length > 0;

            if (Array.from(document.querySelectorAll("sync-blocking-overlay")).some(isOnScreen))
            {
                return true;
            }

            if (Array.from(document.querySelectorAll(".sync-blocking-overlay-backdrop, .sync-blocking-content, .sync-blocking-body")).some(isOnScreen))
            {
                return true;
            }

            return Array.from(document.querySelectorAll("dialog-box"))
                .filter(isOnScreen)
                .some(element => /sync state|getting everything back in sync/i.test(element.textContent || ""));
        }).catch(() => false);
    }

    // A streak or milestone badge earned mid-case raises a celebration that owns
    // the BlockingOverlayCoordinator slot and swallows the next click.
    static async dismissBadgeCelebrationIfPresent(page)
    {
        const bDismissed = await page.evaluate(() =>
        {
            const celebration = Array.from(document.querySelectorAll("badge-celebration, .badge-celebration"))
                .find(element => element.getClientRects().length > 0);
            if (!celebration)
            {
                return false;
            }
            const acknowledgeButton = celebration.querySelector("button, .ok-button, .badge-celebration-continue");
            if (acknowledgeButton)
            {
                acknowledgeButton.click();
                return true;
            }
            return false;
        }).catch(() => false);

        if (bDismissed)
        {
            await BrowserSuiteHelpers.sleep(BrowserSuiteHelpers.SETTLE_MS);
        }
        return bDismissed;
    }

    // Clicks the first VISIBLE match with a real mouse click at its centre, so
    // the app sees the same event sequence a user produces.
    static async clickVisible(page, selector)
    {
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

        // Dialogs scale in over ~200ms and their buttons are small, so a point
        // measured mid-animation can miss by more than the button is wide.
        const readStabilisedCentre = async () =>
        {
            let candidatePoint = await readCentre();
            for (let attemptIndex = 0; attemptIndex < 20; attemptIndex++)
            {
                await BrowserSuiteHelpers.sleep(60);
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
        // Checking for a blocking overlay ONCE at the top loses the race: a write
        // from the previous step lands mid-aim and the overlay goes up between
        // that check and this measurement.
        let point = null;
        const aimDeadline = Date.now() + BrowserSuiteHelpers.AIM_TIMEOUT_MS;

        while (Date.now() < aimDeadline)
        {
            while (Date.now() < aimDeadline && await BrowserSuiteHelpers.syncModalIsUp(page))
            {
                await BrowserSuiteHelpers.sleep(1000);
            }
            await BrowserSuiteHelpers.dismissBadgeCelebrationIfPresent(page);
            await BrowserSuiteHelpers.waitForVisible(page, selector);

            point = await readStabilisedCentre();
            if (!point)
            {
                throw new Error(`No visible element to click for ${selector}`);
            }

            if (point.ownsItsCentre && point.insideViewport)
            {
                break;
            }

            BrowserSuiteHelpers.trace(`    (re-aiming at ${selector}: centre owned by ${point.elementAtCentre}`
                + `${point.insideViewport ? "" : ", point OUTSIDE the viewport"})`);
            await BrowserSuiteHelpers.sleep(500);
        }

        if (!point.ownsItsCentre || !point.insideViewport)
        {
            BrowserSuiteHelpers.trace(`    (WARNING aiming at ${selector}: centre is owned by ${point.elementAtCentre}`
                + `${point.insideViewport ? "" : ", and the point is OUTSIDE the viewport"} — the click may be absorbed)`);
        }

        await page.mouse.click(point.x, point.y);
        await BrowserSuiteHelpers.sleep(BrowserSuiteHelpers.SETTLE_MS);
    }

    /**
     * Clicks, then verifies the click actually did something, and retries if it
     * did not.
     *
     * A plain clickVisible aims carefully but cannot know whether the event was
     * honoured. An overlay raised in the few hundred milliseconds AFTER the
     * click — a sync pull landing, a badge celebration appearing — absorbs it
     * silently, and the failure then surfaces at the NEXT step as "the app
     * ignored the button", pointing at the wrong thing entirely. Anywhere the
     * click has a visible consequence, assert that consequence here instead.
     *
     * @param outcomeFunction runs in page context; return a truthy value once
     *        the click has visibly taken effect.
     */
    static async clickUntil(page, selector, outcomeFunction, outcomeArgument, description, attemptCount = 3)
    {
        let lastValue = null;

        for (let attemptIndex = 1; attemptIndex <= attemptCount; attemptIndex++)
        {
            await BrowserSuiteHelpers.clickVisible(page, selector);

            const deadline = Date.now() + 5000;
            while (Date.now() < deadline)
            {
                lastValue = await page.evaluate(outcomeFunction, outcomeArgument).catch(() => null);
                if (lastValue)
                {
                    return lastValue;
                }
                await BrowserSuiteHelpers.sleep(BrowserSuiteHelpers.POLL_INTERVAL_MS);
            }

            BrowserSuiteHelpers.trace(`    (clicking ${selector} did not produce ${description}; attempt ${attemptIndex} of ${attemptCount})`);

            // Most often the click was swallowed by something that has since
            // gone away, so simply waiting it out and clicking again lands it.
            //
            // BOUNDED, deliberately. This wait used to have no deadline, so a
            // sync modal that never cleared — a stalled cycle, a lock held for
            // its full TTL — hung the suite forever: no timeout, no diagnostic,
            // no result file. A deploy gate that HANGS is worse than one that
            // fails, because CI waits on it indefinitely instead of reporting.
            // Give up waiting and let the retry (and ultimately the throw
            // below) surface it as a failure with a reason.
            const modalWaitDeadline = Date.now() + BrowserSuiteHelpers.SYNC_SETTLE_TIMEOUT_MS;
            while (await BrowserSuiteHelpers.syncModalIsUp(page))
            {
                if (Date.now() > modalWaitDeadline)
                {
                    throw new Error(`Clicked ${selector} but a sync modal has been covering the app for `
                        + `${Math.round(BrowserSuiteHelpers.SYNC_SETTLE_TIMEOUT_MS / 1000)}s and never cleared, so ${description} `
                        + "can never appear. The sync engine is stalled — check Redis (the sync lock lives there) and Mongo latency.");
                }
                await BrowserSuiteHelpers.sleep(1000);
            }
            await BrowserSuiteHelpers.dismissBadgeCelebrationIfPresent(page);
        }

        throw new Error(`Clicked ${selector} ${attemptCount} times but ${description} never appeared `
            + `(last value: ${JSON.stringify(lastValue)})`);
    }

    // Types into a plain <input>. Editors commit their value on `change`, which
    // only fires when focus leaves — the same thing that happens when a user
    // moves on to the next field — so the blur is part of the flow.
    static async typeIntoInput(page, selector, text)
    {
        await BrowserSuiteHelpers.clickVisible(page, selector);

        // Clear with real keystrokes. Assigning .value fires no `input` event,
        // so any live-filtering the field drives would never see it emptied.
        await page.keyboard.down("Control");
        await page.keyboard.press("KeyA");
        await page.keyboard.up("Control");
        await page.keyboard.press("Backspace");

        if (text.length > 0)
        {
            await page.keyboard.type(text, { delay: 8 });
        }

        await page.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur());
        await BrowserSuiteHelpers.sleep(BrowserSuiteHelpers.SETTLE_MS);
    }

    static async waitForNoVisibleDialog(page)
    {
        await BrowserSuiteHelpers.waitUntil(page, () =>
        {
            const dialogs = Array.from(document.querySelectorAll("dialog-box"))
                .filter(element => element.getClientRects().length > 0);
            const backdrops = Array.from(document.querySelectorAll(".dialog-backdrop"))
                .filter(element => element.getClientRects().length > 0);
            return (dialogs.length === 0 && backdrops.length === 0) ? "clear" : null;
        }, null, "every dialog to close");
        await BrowserSuiteHelpers.sleep(BrowserSuiteHelpers.SETTLE_MS);
    }

    // Reads the text of a VALIDATION dialog, ignoring the sync-blocking modal —
    // that one can be on screen for unrelated reasons and would otherwise be
    // mistaken for the app's answer to the action under test.
    static async waitForValidationDialogText(page, description, timeoutMilliseconds = BrowserSuiteHelpers.DEFAULT_WAIT_MS)
    {
        const modalDeadline = Date.now() + 60000;
        while (Date.now() < modalDeadline && await BrowserSuiteHelpers.syncModalIsUp(page))
        {
            await BrowserSuiteHelpers.sleep(1000);
        }

        return BrowserSuiteHelpers.waitUntil(page, () =>
        {
            const text = Array.from(document.querySelectorAll("dialog-box"))
                .filter(element => element.getClientRects().length > 0)
                .map(element => (element.textContent || "").trim())
                .filter(candidate => !/sync state|getting everything back in sync/i.test(candidate))
                .join(" ");
            return text.length > 0 ? text : null;
        }, null, description, timeoutMilliseconds);
    }

    // Answers a dialog through its OK button and waits for it to actually go
    // away. Retried because a dialog appended in the same frame the click is
    // dispatched can miss the event; a second press always lands.
    static async dismissAlert(page)
    {
        for (let attemptIndex = 1; attemptIndex <= 3; attemptIndex++)
        {
            await BrowserSuiteHelpers.clickVisible(page, "dialog-box .ok-button");

            const bClosed = await page.evaluate(() =>
            {
                const dialogs = Array.from(document.querySelectorAll("dialog-box"))
                    .filter(element => element.getClientRects().length > 0);
                return dialogs.length === 0;
            });

            if (bClosed)
            {
                await BrowserSuiteHelpers.waitForNoVisibleDialog(page);
                return;
            }

            BrowserSuiteHelpers.trace(`    (dialog still open after OK press ${attemptIndex}; retrying)`);
            await BrowserSuiteHelpers.sleep(400);
        }

        await BrowserSuiteHelpers.waitForNoVisibleDialog(page);
    }

    // Boot puts up a blocking "Restoring sync state" dialog while the client
    // reconciles with the server. It clears itself; wait it out rather than
    // dismiss it, since dismissing abandons the sync mid-flight and leaves the
    // server-side lock held for its full 5-minute TTL.
    static async waitForSyncToSettle(page)
    {
        const deadline = Date.now() + BrowserSuiteHelpers.SYNC_SETTLE_TIMEOUT_MS;

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
            }
            else
            {
                consecutiveClearChecks += 1;
                if (consecutiveClearChecks >= 4)
                {
                    return true;
                }
            }

            await BrowserSuiteHelpers.sleep(1000);
        }

        return false;
    }

    static async openDeckOptionsMenu(page, deckShortName)
    {
        const tileSelector = await BrowserSuiteHelpers.waitUntil(
            page,
            BrowserSuiteHelpers.deckTileSelectorInPage,
            deckShortName,
            `the deck tile for "${deckShortName}"`);

        await BrowserSuiteHelpers.clickVisible(page, `${tileSelector} .deck-options-button`);
        await BrowserSuiteHelpers.waitForVisible(page, "deck-options-context-menu");
        return tileSelector;
    }

    static async returnToHome(page)
    {
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline)
        {
            const tag = await BrowserSuiteHelpers.currentPageTag(page);
            if (tag === "home-page")
            {
                await BrowserSuiteHelpers.sleep(BrowserSuiteHelpers.SETTLE_MS);
                return true;
            }

            // Close anything modal first, then walk one page back.
            await page.evaluate(() =>
            {
                const closeButton = Array.from(document.querySelectorAll("dialog-box .ok-button, dialog-box .close-button, dialog-box .cancel-button"))
                    .find(element => element.getClientRects().length > 0);
                if (closeButton)
                {
                    closeButton.click();
                }
            }).catch(() => {});

            await page.evaluate(() => window.history.back()).catch(() => {});
            await BrowserSuiteHelpers.sleep(700);
        }
        return false;
    }

    // Screenshot plus a DOM dump, so a failure that only reproduces on someone
    // else's machine still leaves evidence behind.
    static async captureFailureDiagnostics(page, resultFile, caseNumber, message)
    {
        const diagnosticsDirectory = path.join(path.dirname(path.resolve(resultFile)), "diagnostics");
        const stem = path.join(diagnosticsDirectory, `case-${String(caseNumber).padStart(2, "0")}`);

        try
        {
            fs.mkdirSync(diagnosticsDirectory, { recursive: true });
            await page.screenshot({ path: `${stem}.png`, fullPage: true });
            const html = await page.content();
            fs.writeFileSync(`${stem}.html`, `<!-- ${message} -->\n${html}`, "utf-8");
        }
        catch (diagnosticsError)
        {
            return `(diagnostics capture failed: ${diagnosticsError.message})`;
        }

        return stem;
    }
}

module.exports = { BrowserSuiteHelpers, EnvironmentUnavailableError };
