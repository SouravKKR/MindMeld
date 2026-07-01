import TutorialRegistry from "../Constants/TutorialRegistry.js";
import TutorialCompletionTracker from "./TutorialCompletionTracker.js";
import TutorialEntityCleanup from "./TutorialEntityCleanup.js";
import NavigationEvents from "../Events/NavigationEvents.js";
import BlockingOverlayCoordinator from "./BlockingOverlayCoordinator.js";

// PageNavigator is lazy-imported on demand to avoid a class-load-time
// import cycle (PageNavigator pulls in every page module, several of
// which transitively reference TutorialEngine via the editor-page
// CREATED_DURING_TUTORIAL_KEY flagging).

/**
 * TutorialEngine
 *
 * Orchestrates the lifecycle of a running tutorial:
 *   - drives the global <tutorial-overlay> through each step
 *   - exposes CREATED_DURING_TUTORIAL_KEY so the editor pages can flag
 *     every entity the user creates while the tour is active
 *   - on Start over, deletes all flagged entities and rewinds to step 0
 *   - on Finish or Skip, offers a "Clear all items created during this
 *     tutorial" prompt and (if checked) runs the same cleanup
 *   - marks completion in TutorialCompletionTracker
 *
 * The engine is a static singleton — only one tutorial can run at a
 * time. Calling play(...) while a tutorial is active is a no-op.
 *
 * Auto-play on first device launch: maybeAutoPlay() is invoked once the
 * Home page has had a chance to render (see TutorialBootstrap), and
 * after the T&C dialog has resolved.
 */
class TutorialEngine
{
    /**
     * Editor pages set additionalData[CREATED_DURING_TUTORIAL_KEY] = true
     * on entities the user creates while isRunning() is true. The cleanup
     * routine deletes every entity carrying that flag.
     */
    static CREATED_DURING_TUTORIAL_KEY = "bCreatedDuringTutorial";

    static #COORDINATOR_OWNER_ID = "TutorialOverlay";

    static #activeTutorial      = null;
    static #activeStepIndex     = -1;
    static #autoPlayAttempted   = false;
    static #navigationListenerRegistered = false;
    static #bSuppressNavigationGuard     = false;
    static #pendingStepSetupAction       = null;
    static #bHoldingCoordinatorSlot      = false;
    // Resolves when the currently-active tutorial exits (finish or
    // skip). Held while a tutorial is running so LoginPopupSequence can
    // await it before opening the next welcome popup.
    static #activeTutorialExitResolver   = null;

    static getOverlayElement()
    {
        let overlay = document.querySelector("tutorial-overlay");

        if (!overlay)
        {
            overlay = document.createElement("tutorial-overlay");
            document.body.appendChild(overlay);
        }

        return overlay;
    }

    static isRunning()
    {
        return TutorialEngine.#activeTutorial !== null;
    }

    /**
     * Plays the tutorial with the given id (from TutorialRegistry).
     * Returns false if another tutorial is already running, true if
     * playback started.
     */
    static play(tutorialId)
    {
        if (TutorialEngine.isRunning())
        {
            console.warn(`[TutorialEngine] Cannot start "${tutorialId}" — another tutorial is already running.`);
            return false;
        }

        const tutorial = TutorialRegistry.getById(tutorialId);

        if (!tutorial)
        {
            console.error(`[TutorialEngine] Unknown tutorial id: ${tutorialId}`);
            return false;
        }

        if (!tutorial.steps || tutorial.steps.length === 0)
        {
            console.warn(`[TutorialEngine] Tutorial "${tutorialId}" has no steps.`);
            return false;
        }

        TutorialEngine.#activeTutorial  = tutorial;
        TutorialEngine.#activeStepIndex = 0;

        TutorialEngine.#ensureNavigationGuardRegistered();

        // Wait for the blocking-overlay coordinator slot before mounting
        // the tutorial overlay. On first launch the initialization
        // overlay and sync-blocking dialog may still be on screen — if
        // we mounted directly, the tutorial would pile on top of them
        // and the user would see all three stacked.
        TutorialEngine.#mountWhenSlotAvailable();

        return true;
    }

    static async #mountWhenSlotAvailable()
    {
        await BlockingOverlayCoordinator.request(TutorialEngine.#COORDINATOR_OWNER_ID);

        // Tutorial may have been exited before our turn (rare — the
        // user couldn't have clicked Skip without the overlay being
        // visible — but the engine's #requestExit can also be invoked
        // programmatically). Bail and release symmetrically.
        if (!TutorialEngine.isRunning())
        {
            BlockingOverlayCoordinator.release(TutorialEngine.#COORDINATOR_OWNER_ID);
            return;
        }

        TutorialEngine.#bHoldingCoordinatorSlot = true;
        TutorialEngine.#renderCurrentStep();
    }

    /**
     * Idempotent — registers the PAGE_OPENED listener exactly once per
     * page load. The listener watches for navigations that fall outside
     * the active tutorial step's expected page and triggers a clean
     * restart (pop the page stack to Home, then re-render step 0). The
     * tutorial itself navigates between pages during WAIT_FOR_CLICK /
     * WAIT_FOR_EVENT steps — those are flagged "expected" via each
     * step's `expectedPageTagName` field so the guard knows to allow
     * them through.
     */
    static #ensureNavigationGuardRegistered()
    {
        if (TutorialEngine.#navigationListenerRegistered)
        {
            return;
        }
        TutorialEngine.#navigationListenerRegistered = true;

        window.addEventListener(NavigationEvents.PAGE_OPENED, (navigationEvent) =>
        {
            TutorialEngine.#handlePageOpenedDuringTutorial(navigationEvent.detail?.pageTagName);
        });
    }

    static #handlePageOpenedDuringTutorial(pageTagName)
    {
        if (!TutorialEngine.isRunning())
        {
            return;
        }

        // The engine itself navigates back to Home as part of restart /
        // start-over recovery. Re-entering the guard during that
        // sequence would loop forever — the flag breaks the cycle.
        if (TutorialEngine.#bSuppressNavigationGuard)
        {
            return;
        }

        const tutorial = TutorialEngine.#activeTutorial;
        const currentStep = tutorial.steps[TutorialEngine.#activeStepIndex];
        const nextStep    = tutorial.steps[TutorialEngine.#activeStepIndex + 1] || null;

        const expectedTagNames = new Set();
        if (currentStep?.expectedPageTagName)
        {
            expectedTagNames.add(currentStep.expectedPageTagName);
        }
        if (nextStep?.expectedPageTagName)
        {
            expectedTagNames.add(nextStep.expectedPageTagName);
        }

        // No expectations encoded → assume the step author hasn't
        // opted into navigation checking yet; don't interrupt them.
        if (expectedTagNames.size === 0)
        {
            return;
        }

        if (expectedTagNames.has(pageTagName))
        {
            return;
        }

        console.warn(`[TutorialEngine] Unexpected navigation to "${pageTagName}" during step ${TutorialEngine.#activeStepIndex} of "${tutorial.id}" — restarting tutorial from Home.`);
        TutorialEngine.#resetToHomeAndRestart();
    }

    /**
     * Pops the PageNavigator stack down to Home, then renders step 0 of
     * the active tutorial. Used by both the user-triggered Start Over
     * button and the unexpected-navigation guard.
     */
    static async #resetToHomeAndRestart()
    {
        if (!TutorialEngine.isRunning())
        {
            return;
        }

        TutorialEngine.#bSuppressNavigationGuard = true;
        try
        {
            await TutorialEngine.#popPageStackToHome();
        }
        finally
        {
            TutorialEngine.#bSuppressNavigationGuard = false;
        }

        TutorialEngine.#activeStepIndex = 0;
        TutorialEngine.#renderCurrentStep();
    }

    /**
     * Auto-play on first device launch — only fires once per device, only
     * for tutorials flagged bAutoPlayOnFirstLaunch. Independent of login
     * state. If another tutorial is already running this call is a no-op.
     *
     * Returns a Promise that resolves once the auto-played tutorial has
     * exited (Finish or Skip). Resolves immediately when no tutorial
     * needs to play. LoginPopupSequence awaits it so the model-download
     * dialog only opens after the user has finished the tour.
     */
    static async maybeAutoPlay()
    {
        if (TutorialEngine.#autoPlayAttempted)
        {
            return;
        }

        TutorialEngine.#autoPlayAttempted = true;

        if (TutorialEngine.isRunning())
        {
            return;
        }

        const autoPlayTutorials = TutorialRegistry.getAutoPlayOnFirstLaunch();

        for (const tutorial of autoPlayTutorials)
        {
            const bAlreadyCompleted = await TutorialCompletionTracker.isCompleted(tutorial.id);

            if (!bAlreadyCompleted)
            {
                // Set the exit resolver BEFORE play() so #requestExit
                // (which can fire synchronously inside play in degenerate
                // cases — e.g. a tutorial with zero steps) always sees a
                // resolver to call.
                const exitPromise = new Promise((resolveExit) =>
                {
                    TutorialEngine.#activeTutorialExitResolver = resolveExit;
                });

                const bStarted = TutorialEngine.play(tutorial.id);

                if (!bStarted)
                {
                    // play() bailed (unknown id, no steps, ...). Resolve
                    // immediately so callers don't hang.
                    if (TutorialEngine.#activeTutorialExitResolver)
                    {
                        TutorialEngine.#activeTutorialExitResolver();
                        TutorialEngine.#activeTutorialExitResolver = null;
                    }
                    return;
                }

                await exitPromise;
                return;
            }
        }
    }

    /**
     * Boot-time orphan sweep.
     *
     * Cleanup of tutorial-created entities normally runs from the
     * overlay's Skip / Finish / Start-over buttons (#requestExit /
     * #requestStartOver). None of those fire when the page is torn down
     * mid-tutorial — a reload, a closed tab, a crash, or any other
     * unexpected exit. In those cases the deck / card / study-material /
     * mock-test the user created during the tour keeps its
     * CREATED_DURING_TUTORIAL_KEY flag on disk and is never deleted.
     *
     * Because every clean exit deletes all flagged entities, any flagged
     * entity still present at boot is by definition an orphan from a
     * previously-abandoned tutorial. Delete them.
     *
     * Must be awaited BEFORE maybeAutoPlay so a freshly-started tutorial's
     * own (legitimately flagged) entities aren't swept out from under it.
     * No-ops while a tutorial is running, as a guard against being called
     * out of order.
     */
    static async sweepOrphanedTutorialEntities()
    {
        if (TutorialEngine.isRunning())
        {
            return;
        }

        const summary = await TutorialEntityCleanup.clearTutorialCreatedItems(TutorialEngine.CREATED_DURING_TUTORIAL_KEY);

        const bSweptAnything =
            summary.decks > 0 ||
            summary.cards > 0 ||
            summary.studyMaterials > 0 ||
            summary.mockTests > 0;

        if (bSweptAnything)
        {
            console.log("[TutorialEngine] Swept orphaned items from an abandoned tutorial:", summary);
        }
    }

    // ── Internals ─────────────────────────────────────────────────────

    static #renderCurrentStep()
    {
        const tutorial = TutorialEngine.#activeTutorial;
        const stepIndex = TutorialEngine.#activeStepIndex;
        const step = tutorial.steps[stepIndex];

        const overlay = TutorialEngine.getOverlayElement();

        overlay.showStep(step,
        {
            stepIndex:   stepIndex,
            stepCount:   tutorial.steps.length,
            bIsLastStep: stepIndex === tutorial.steps.length - 1,
            callbacks:
            {
                onStartOver: () => TutorialEngine.#requestStartOver(),
                onNext:      () => TutorialEngine.#goNext(),
                onSkip:      () => TutorialEngine.#requestExit({ bSkipped: true }),
                onFinish:    () => TutorialEngine.#requestExit({ bSkipped: false })
            }
        });

        // Kick off any step-level async setup (e.g. building a sample
        // deck for the How-to-Study tutorial). The Promise is held on
        // #pendingStepSetupAction so #goNext can await it before
        // advancing — that way a fast user who hits Next before the
        // setup finishes just pauses briefly instead of advancing into
        // a step whose target DOM doesn't exist yet.
        if (typeof step.setupAction === "function")
        {
            TutorialEngine.#pendingStepSetupAction = Promise.resolve()
                .then(() => step.setupAction())
                .catch(setupError =>
                {
                    console.warn(`[TutorialEngine] setupAction error on step ${stepIndex}:`, setupError);
                });
        }
        else
        {
            TutorialEngine.#pendingStepSetupAction = null;
        }
    }

    static async #goNext()
    {
        const tutorial = TutorialEngine.#activeTutorial;

        // Block advancement until the current step's setupAction (if
        // any) has finished — otherwise we race the DOM of the next
        // step.
        if (TutorialEngine.#pendingStepSetupAction)
        {
            await TutorialEngine.#pendingStepSetupAction;
            TutorialEngine.#pendingStepSetupAction = null;
        }

        if (TutorialEngine.#activeStepIndex < tutorial.steps.length - 1)
        {
            TutorialEngine.#activeStepIndex++;
            TutorialEngine.#renderCurrentStep();
        }
        else
        {
            TutorialEngine.#requestExit({ bSkipped: false });
        }
    }

    /**
     * Clears all tutorial-created entities, pops the page stack back to
     * Home, and rewinds to step 0 of the active tutorial. Triggered by
     * the overlay's Start over button. Asks for confirmation first
     * because it deletes real on-disk data.
     */
    static async #requestStartOver()
    {
        const tutorial = TutorialEngine.#activeTutorial;

        if (!tutorial)
        {
            return;
        }

        // Lazy-import DialogBox so this module doesn't take a hard dependency
        // on a UI component at load time.
        const DialogBoxModule = await import("../../CommonComponents/DialogBox.js");
        const DialogBox = DialogBoxModule.default;

        // The tutorial overlay sits at z-index 2147483500, well above the
        // DialogBox stacking range, so without explicitly hiding the
        // overlay first the confirmation prompt would be visually buried
        // under the tutorial tooltip. Hide it for the duration of the
        // confirm, then re-render the current step afterward — re-render
        // restores the overlay whether the user confirmed or cancelled.
        const overlay = TutorialEngine.getOverlayElement();
        overlay.hide();

        const bConfirmed = await DialogBox.confirm(
            "Start over?",
            "This will delete any deck, card or study material you created during this tutorial, then restart from step 1."
        );

        if (!bConfirmed)
        {
            TutorialEngine.#renderCurrentStep();
            return;
        }

        const summary = await TutorialEntityCleanup.clearTutorialCreatedItems(TutorialEngine.CREATED_DURING_TUTORIAL_KEY);
        console.log("[TutorialEngine] Start-over cleanup:", summary);

        await TutorialEngine.#resetToHomeAndRestart();
    }

    static async #requestExit({ bSkipped })
    {
        const tutorial = TutorialEngine.#activeTutorial;

        const overlay = TutorialEngine.getOverlayElement();
        overlay.hide();

        // Release the blocking-overlay slot the moment the overlay
        // visually disappears, so any queued overlay (a sync prompt
        // that triggered mid-tutorial, say) can take over immediately.
        // We track #bHoldingCoordinatorSlot so we never double-release —
        // a programmatic exit before #mountWhenSlotAvailable resolves
        // would leave the slot already in someone else's hands.
        if (TutorialEngine.#bHoldingCoordinatorSlot)
        {
            BlockingOverlayCoordinator.release(TutorialEngine.#COORDINATOR_OWNER_ID);
            TutorialEngine.#bHoldingCoordinatorSlot = false;
        }

        // Always clear everything created during the tutorial — there is no
        // opt-out. The sample deck / cards / mock test / demo decks only exist
        // to drive the tour, so removing them on exit is the expected behaviour.
        const summary = await TutorialEntityCleanup.clearTutorialCreatedItems(TutorialEngine.CREATED_DURING_TUTORIAL_KEY);
        console.log("[TutorialEngine] Cleared tutorial-created items:", summary);

        await TutorialEngine.#showFinishDialog({
            bSkipped,
            tutorialTitle: tutorial?.title || "Tutorial"
        });

        if (tutorial)
        {
            await TutorialCompletionTracker.markCompleted(tutorial.id, bSkipped);
        }

        TutorialEngine.#activeTutorial  = null;
        TutorialEngine.#activeStepIndex = -1;
        TutorialEngine.#pendingStepSetupAction = null;

        // Land the user on the home page at the root deck regardless of
        // whether they finished, skipped, or were mid-flight in a deeper
        // page (study session, card editor, etc.). Runs AFTER the engine
        // state is cleared so the navigation guard installed at play()
        // time doesn't interpret the pops as unexpected.
        await TutorialEngine.#resetViewToHomeRoot();

        // Signal LoginPopupSequence (or anyone else awaiting the
        // currently-active tutorial) that we're done. Done last so any
        // queued welcome popup arrives only after the home page has
        // settled back at the root deck.
        if (TutorialEngine.#activeTutorialExitResolver)
        {
            const resolver = TutorialEngine.#activeTutorialExitResolver;
            TutorialEngine.#activeTutorialExitResolver = null;
            resolver();
        }
    }

    static async #resetViewToHomeRoot()
    {
        await TutorialEngine.#popPageStackToHome();

        // Reset HomePage's deck drill state so the user sees root-level
        // tiles, not whatever subdeck they last drilled into during the
        // tutorial. EXPAND(root) is the canonical signal the home page
        // listens for — it also rebuilds the visible tile grid.
        try
        {
            const deckModule = await import("../Model/Deck.js");
            const Deck = deckModule.default;
            const deckEventsModule = await import("../Events/DeckEvents.js");
            const DeckEvents = deckEventsModule.default;
            const rootDeck = Deck.getRoot();
            if (rootDeck)
            {
                window.dispatchEvent(new CustomEvent(DeckEvents.EXPAND, {detail: {deck: rootDeck}}));
            }
        }
        catch (resetError)
        {
            console.warn("[TutorialEngine] Failed to reset to root deck:", resetError);
        }
    }

    static async #popPageStackToHome()
    {
        const pageNavigatorModule = await import("./PageNavigator.js");
        const PageNavigator = pageNavigatorModule.default;

        // Cap the loop so a buggy PageNavigator can't spin forever.
        let popsRemaining = 100;
        while (PageNavigator.canGoBack() && popsRemaining > 0)
        {
            PageNavigator.back();
            popsRemaining--;
        }

        // A tutorial that walked a real flow ending in clearAndOpen has no Home
        // left in the stack to pop back to — the mock-test walkthrough, for
        // instance, lands on the answer key via a wiped stack, so the loop
        // above pops nothing and we'd otherwise strand the user there.
        // Guarantee we end on Home regardless of how the stack was left.
        const currentPage = PageNavigator.getCurrentPage ? PageNavigator.getCurrentPage() : null;
        const currentTagName = currentPage ? currentPage.tagName.toLowerCase() : "";
        if (currentTagName !== "home-page")
        {
            if (typeof PageNavigator.clearAndOpen === "function")
            {
                PageNavigator.clearAndOpen("home-page");
            }
            else
            {
                PageNavigator.open("home-page");
            }
        }
    }

    /**
     * Promise-based finish acknowledgement dialog. Resolves once the user
     * clicks Done. Cleanup of tutorial-created items already happened before
     * this is shown, so there is no opt-out checkbox.
     */
    static #showFinishDialog({ bSkipped, tutorialTitle })
    {
        return new Promise((resolve) =>
        {
            const dialog = document.createElement("dialog-box");
            dialog.classList.add("tutorial-finish-dialog");
            document.body.appendChild(dialog);

            const heading = bSkipped ? "Tutorial Skipped" : `Finished: ${tutorialTitle}`;

            dialog.innerHTML =
            `
                <div class="title-section">${heading}</div>
                <div class="message-section">
                    <p>You can replay this tutorial any time from the sidebar's <strong>Tutorial</strong> button.</p>
                </div>
                <div class="button-section">
                    <button class="tutorial-finish-done-button ok-button">Done</button>
                </div>
            `;

            const doneButton = dialog.querySelector(".tutorial-finish-done-button");

            doneButton.addEventListener("click", () =>
            {
                dialog.remove();
                resolve();
            });
        });
    }
}

export default TutorialEngine;
