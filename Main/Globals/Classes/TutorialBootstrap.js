import TutorialEngine from "./TutorialEngine.js";
import DeckEvents from "../Events/DeckEvents.js";

/**
 * TutorialBootstrap
 *
 * Step 2 of `LoginPopupSequence`. Invoked once the legal modal (step 1)
 * has been agreed to and the deck tree has finished booting.
 *
 * Highlight-style tutorial steps target real DOM elements (deck tiles,
 * etc.) so before kicking off `TutorialEngine.maybeAutoPlay()` we wait
 * for evidence that the home page has actually rendered those tiles.
 * The Home page emits `DeckEvents.EXPAND` once decks are loaded; we hook
 * either that or a short post-window-load fallback to know it is safe
 * to play. Both paths are capped by an absolute timeout so the welcome
 * chain never deadlocks waiting for a render signal that, for some
 * exotic reason, never fires (zero decks in an offline-only session, a
 * navigation away from Home before render, etc.).
 *
 * Auto-play is once per device — `TutorialEngine.#autoPlayAttempted`
 * short-circuits subsequent calls within the same page lifecycle, and
 * `TutorialCompletionTracker` skips tutorials already marked completed.
 */
class TutorialBootstrap
{
    static #RENDER_DELAY_MILLISECONDS         = 400;
    static #RENDER_WAIT_TIMEOUT_MILLISECONDS  = 8000;

    // Track DeckEvents.EXPAND from module load time, not from runForLogin,
    // because the home page mounts in parallel with the legal modal —
    // by the time runForLogin is called Terms has usually been accepted,
    // and EXPAND has long since fired. A listener registered at that
    // point would miss the event and have to fall back to the 8s
    // timeout, leaving the tutorial sitting on a 'loading' state for
    // several seconds after Terms disappears.
    static #bExpandFired = false;

    static
    {
        window.addEventListener(DeckEvents.EXPAND, () =>
        {
            TutorialBootstrap.#bExpandFired = true;
        }, { once: true });
    }

    // ── End-to-end test seam (opt-in) ─────────────────────────────────
    // When the app is loaded with ?tutorialE2E=1, expose a tiny control
    // surface on window.__tutorialE2E that the Puppeteer tutorial UI suite
    // (Common/Testing/Main/run_tutorial_ui_tests.js) uses to drive each
    // tutorial deterministically: list the tutorials, return to a clean
    // Home, start one, and read the current page tag. It exposes ONLY
    // public UI-orchestration methods — no secrets — and additionally marks
    // every tutorial completed so first-launch autoplay never races the
    // suite for the blocking-overlay slot. Gated behind the query flag so
    // it is inert for real users and never present in a normal session.
    static
    {
        try
        {
            const searchParameters = new URLSearchParams(window.location.search);
            if (searchParameters.has("tutorialE2E"))
            {
                TutorialBootstrap.#installEndToEndTestSeam();
            }
        }
        catch (seamError)
        {
            console.warn("[TutorialBootstrap] E2E test seam install failed:", seamError);
        }
    }

    static async #installEndToEndTestSeam()
    {
        // Lazy-import the rest so the seam pulls these modules in only when
        // the flag is set, and to mirror the codebase's import-cycle-avoidance
        // pattern (PageNavigator transitively references the tutorial engine).
        const [registryModule, pageNavigatorModule, completionTrackerModule] = await Promise.all([
            import("../Constants/TutorialRegistry.js"),
            import("./PageNavigator.js"),
            import("./TutorialCompletionTracker.js")
        ]);

        const TutorialRegistry          = registryModule.default;
        const PageNavigator             = pageNavigatorModule.default;
        const TutorialCompletionTracker = completionTrackerModule.default;

        // Suppress first-launch autoplay so the suite — not the login
        // sequence — decides which tutorial runs and when.
        for (const tutorial of TutorialRegistry.getAll())
        {
            try
            {
                await TutorialCompletionTracker.markCompleted(tutorial.id, false);
            }
            catch (ignoredError)
            {
                // Best-effort; a failed mark just means autoplay might run,
                // which the suite tolerates.
            }
        }

        window.__tutorialE2E =
        {
            listTutorials: () => TutorialRegistry.getAll().map(tutorial =>
                ({ id: tutorial.id, title: tutorial.title, stepCount: tutorial.steps.length })),

            isRunning: () => TutorialEngine.isRunning(),

            play: (tutorialId) => TutorialEngine.play(tutorialId),

            goHome: () =>
            {
                if (typeof PageNavigator.clearAndOpen === "function")
                {
                    PageNavigator.clearAndOpen("home-page");
                }
                else
                {
                    PageNavigator.open("home-page");
                }
            },

            currentPageTag: () =>
            {
                const currentPage = typeof PageNavigator.getCurrentPage === "function"
                    ? PageNavigator.getCurrentPage()
                    : null;
                return currentPage ? currentPage.tagName.toLowerCase() : "";
            }
        };

        console.log("[TutorialBootstrap] E2E tutorial test seam installed (window.__tutorialE2E).");
    }

    /**
     * Public entry point invoked by LoginPopupSequence. Resolves only
     * after the auto-played tutorial has exited (Finish or Skip), or
     * immediately when no tutorial needs to play on this device.
     */
    static async runForLogin()
    {
        await TutorialBootstrap.#waitForHomePageRender();

        // Before anything auto-plays, delete any entities left flagged by
        // a tutorial that was abandoned without a clean exit (reload, tab
        // close, crash). The deck tree is in memory by now — the render
        // wait above resolves off DeckEvents.EXPAND — so the sweep can see
        // every flagged deck / card / study material / mock test. Must run
        // before maybeAutoPlay so a tutorial that starts on THIS launch
        // doesn't have its own freshly-created entities swept.
        await TutorialEngine.sweepOrphanedTutorialEntities();

        await TutorialEngine.maybeAutoPlay();
    }

    /**
     * Resolves when either `DeckEvents.EXPAND` has fired (so the deck
     * tile grid is mounted) plus a short settle delay, or after a hard
     * timeout — whichever comes first. The 400 ms settle delay matches
     * the legacy two-listener bootstrap; it gives the home-page tiles
     * time to actually paint before the tutorial highlight measures
     * them.
     */
    static #waitForHomePageRender()
    {
        return new Promise((resolve) =>
        {
            let bResolved = false;
            const finish = () =>
            {
                if (bResolved) return;
                bResolved = true;
                resolve();
            };

            if (TutorialBootstrap.#bExpandFired)
            {
                setTimeout(finish, TutorialBootstrap.#RENDER_DELAY_MILLISECONDS);
                return;
            }

            window.addEventListener(DeckEvents.EXPAND, () =>
            {
                setTimeout(finish, TutorialBootstrap.#RENDER_DELAY_MILLISECONDS);
            }, { once: true });

            // Belt-and-braces: don't hang the welcome chain forever if
            // the EXPAND event never arrives (offline session with zero
            // decks, navigation away from Home before tiles paint, ...).
            setTimeout(finish, TutorialBootstrap.#RENDER_WAIT_TIMEOUT_MILLISECONDS);
        });
    }
}

export default TutorialBootstrap;
