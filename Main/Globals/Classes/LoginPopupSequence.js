import AuthenticationEvents from "../Events/AuthenticationEvents.js";
import InitializationEvents from "../Events/InitializationEvents.js";
import TermsAndConditionsManager from "./TermsAndConditionsManager.js";
import TutorialBootstrap from "./TutorialBootstrap.js";
import ReleaseNotesBootstrap from "./ReleaseNotesBootstrap.js";

/**
 * LoginPopupSequence
 *
 * Centralises the post-login popup choreography so the user never sees
 * two welcome popups visible at the same time. Without this class each
 * subsystem (terms, tutorial, release notes) reacted to
 * ON_USER_LOGGED_IN on its own — and because they use different
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
 *   3. Release notes for any version the user hasn't seen yet.
 *
 * The offline-AI-model download is deliberately NOT part of this
 * choreography — it is offered on demand from Settings ▸ AI (the Free
 * row of the model picker), never as a login-time prompt.
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
 *   - InitializationEvents.COMPLETE must have fired before steps 2-3 so
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
            const acceptedAnyDocument = await TermsAndConditionsManager.runForLogin(user);

            // The login streak is withheld server-side until the user has
            // accepted the terms, then advanced the moment the final document
            // is accepted. If the user just agreed, refresh from the server so
            // that now-advanced streak — and any badge it earned — surfaces in
            // this session instead of only on the next launch.
            if (acceptedAnyDocument)
            {
                await AuthenticationEvents.refreshUserFromServer();
            }
        }
        catch (termsError)
        {
            console.error("[LoginPopupSequence] Terms step failed:", termsError);
            return;
        }

        // Steps 2-3 both touch the home page (the tutorial highlights
        // real deck tiles). Hold here until the deck tree boot has fired.
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

        // The offline-AI-model download is intentionally NOT prompted here
        // anymore — it is offered only on demand from Settings ▸ AI (the
        // Free row of the model picker). See LlmTierSelect.

        // Step 3 — Release notes for any unseen version. Runs last so a
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
