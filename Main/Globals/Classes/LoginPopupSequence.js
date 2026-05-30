import AuthenticationEvents from "../Events/AuthenticationEvents.js";
import InitializationEvents from "../Events/InitializationEvents.js";
import TermsAndConditionsManager from "./TermsAndConditionsManager.js";
import TutorialBootstrap from "./TutorialBootstrap.js";
import BrowserLlmDownloadBootstrap from "./BrowserLlm/BrowserLlmDownloadBootstrap.js";
import ReleaseNotesBootstrap from "./ReleaseNotesBootstrap.js";

/**
 * LoginPopupSequence
 *
 * Centralises the post-login popup choreography so the user never sees
 * two welcome popups visible at the same time. Without this class each
 * subsystem (terms, tutorial, model download, release notes) reacted to
 * ON_USER_LOGGED_IN on its own — and because the four use different
 * presentation layers (DialogBox queue vs raw <dialog-box> vs
 * <tutorial-overlay>) they had no way to coordinate. New users were
 * therefore "blasted" with overlapping modals.
 *
 * The sequence — strictly serial:
 *
 *   1. Privacy Policy + Terms of Service. Mandatory; nothing else opens
 *      until every server-listed legal document is accepted.
 *   2. Beginners tutorial (auto-play once per device; carries the
 *      MindMeld Knowledge Consolidation Lifecycle diagram on step 1).
 *   3. Local AI model download prompt (only when WebGPU exists and the
 *      download state is NOT_STARTED — i.e. the device is compatible
 *      and the user hasn't already accepted/declined on this device).
 *   4. Release notes for any version the user hasn't seen yet.
 *
 * Each step is invoked through the subsystem's public runForLogin(user)
 * method. The subsystems no longer install their own ON_USER_LOGGED_IN
 * listeners — this class is the single dispatcher. Failures in any one
 * step are logged but never block the next step (terms is the exception:
 * the terms manager itself logs-out-and-reloads on decline, so on return
 * we never reach step 2).
 *
 * Gating prerequisites:
 *   - ON_USER_LOGGED_IN must have fired (to know who to prompt for).
 *   - InitializationEvents.COMPLETE must have fired before steps 2-4 so
 *     the home page has rendered (the tutorial highlights real deck
 *     tiles). Terms doesn't need init complete and runs as soon as the
 *     login event arrives — getting the legal modal up ASAP is the whole
 *     point of "no logic runs without acceptance".
 *
 * Re-entry: ON_USER_LOGGED_OUT resets the session-once flag so the
 * sequence can run again for the next account that signs in within the
 * same page lifecycle.
 */
class LoginPopupSequence
{
    static #bSequenceStarted = false;
    static #user = null;
    static #bInitializationComplete = false;
    static #initializationCompletePromise = null;
    static #initializationCompleteResolver = null;

    static
    {
        LoginPopupSequence.#initializationCompletePromise = new Promise((resolve) =>
        {
            LoginPopupSequence.#initializationCompleteResolver = resolve;
        });

        window.addEventListener(InitializationEvents.COMPLETE, () =>
        {
            LoginPopupSequence.#bInitializationComplete = true;
            if (LoginPopupSequence.#initializationCompleteResolver)
            {
                LoginPopupSequence.#initializationCompleteResolver();
                LoginPopupSequence.#initializationCompleteResolver = null;
            }
        });

        window.addEventListener(AuthenticationEvents.ON_USER_LOGGED_IN, (event) =>
        {
            LoginPopupSequence.#onUserLoggedIn(event.detail?.user);
        });

        window.addEventListener(AuthenticationEvents.ON_USER_LOGGED_OUT, () =>
        {
            LoginPopupSequence.#bSequenceStarted = false;
            LoginPopupSequence.#user = null;
        });
    }

    static #onUserLoggedIn(user)
    {
        if (!user)
        {
            return;
        }

        // The session may emit multiple ON_USER_LOGGED_IN events in a
        // single page lifecycle (fresh-vs-stale-offline rehydration is
        // the common case). The first one wins — we don't want to
        // reopen the welcome flow on a stale-offline replay.
        if (LoginPopupSequence.#bSequenceStarted)
        {
            return;
        }

        LoginPopupSequence.#bSequenceStarted = true;
        LoginPopupSequence.#user = user;
        LoginPopupSequence.#runSequence();
    }

    static async #runSequence()
    {
        const user = LoginPopupSequence.#user;

        // Step 1 — Terms / Privacy. Runs immediately; intentionally does
        // not wait for InitializationEvents.COMPLETE because the legal
        // modal should land as soon as humanly possible.
        try
        {
            await TermsAndConditionsManager.runForLogin(user);
        }
        catch (termsError)
        {
            console.error("[LoginPopupSequence] Terms step failed:", termsError);
            return;
        }

        // Steps 2-4 all touch the home page (tutorial highlights real
        // deck tiles, model-download prompt expects the app to look
        // ready). Hold here until the deck tree boot has fired.
        if (!LoginPopupSequence.#bInitializationComplete)
        {
            await LoginPopupSequence.#initializationCompletePromise;
        }

        // Step 2 — Tutorial (Beginners, including the lifecycle diagram).
        try
        {
            await TutorialBootstrap.runForLogin(user);
        }
        catch (tutorialError)
        {
            console.error("[LoginPopupSequence] Tutorial step failed:", tutorialError);
        }

        // Step 3 — Local AI model download (only if WebGPU is present
        // and state is NOT_STARTED; the subsystem handles those gates).
        try
        {
            await BrowserLlmDownloadBootstrap.runForLogin(user);
        }
        catch (modelDownloadError)
        {
            console.error("[LoginPopupSequence] Model-download step failed:", modelDownloadError);
        }

        // Step 4 — Release notes for any unseen version. Runs last so a
        // returning user with no other pending step still sees them.
        try
        {
            await ReleaseNotesBootstrap.runForLogin(user);
        }
        catch (releaseNotesError)
        {
            console.error("[LoginPopupSequence] Release-notes step failed:", releaseNotesError);
        }
    }
}

export default LoginPopupSequence;
