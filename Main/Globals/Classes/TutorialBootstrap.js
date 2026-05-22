import TutorialEngine from "./TutorialEngine.js";
import DeckEvents from "../Events/DeckEvents.js";
import TermsAndConditionsManager from "./TermsAndConditionsManager.js";

/**
 * TutorialBootstrap
 *
 * Decides when to call TutorialEngine.maybeAutoPlay() on app boot.
 *
 * Highlight-style tutorial steps target real DOM elements (deck tiles,
 * etc.) — so we need to wait until the home page has actually rendered
 * those tiles before attempting auto-play. The Home page emits
 * DeckEvents.EXPAND once decks are loaded; we listen for the first such
 * event with a short delay to allow the tile render to complete.
 *
 * Before kicking off the tutorial we also wait for any pending T&C
 * dialog to resolve, so the tour doesn't open behind the legal modal.
 *
 * As a safety net, we also fall back to a delayed probe after window
 * load in case the DeckEvents.EXPAND event has already fired before this
 * module registered its listener (e.g. fresh login with no decks).
 *
 * Auto-play is once per device — TutorialEngine itself short-circuits if
 * the tutorial is already marked completed in the local tracker.
 */
class TutorialBootstrap
{
    static #AUTO_PLAY_RENDER_DELAY_MILLISECONDS   = 400;
    static #AUTO_PLAY_FALLBACK_DELAY_MILLISECONDS = 1500;

    static
    {
        window.addEventListener(DeckEvents.EXPAND, () =>
        {
            setTimeout(() =>
            {
                TutorialBootstrap.#probeAutoPlay();
            }, TutorialBootstrap.#AUTO_PLAY_RENDER_DELAY_MILLISECONDS);
        }, { once: true });

        // Fallback in case DeckEvents.EXPAND never fires (e.g. zero decks).
        window.addEventListener("load", () =>
        {
            setTimeout(() =>
            {
                TutorialBootstrap.#probeAutoPlay();
            }, TutorialBootstrap.#AUTO_PLAY_FALLBACK_DELAY_MILLISECONDS);
        }, { once: true });
    }

    static async #probeAutoPlay()
    {
        // Hold the tutorial until the T&C dialog (if any) is dismissed.
        await TermsAndConditionsManager.getPendingPromise();
        TutorialEngine.maybeAutoPlay();
    }
}

export default TutorialBootstrap;
