import AuthenticationEvents from "../../Events/AuthenticationEvents.js";
import InitializationEvents from "../../Events/InitializationEvents.js";
import { browserLlmDownloadStates } from "../../Enumerations/BrowserLlmDownloadStates.js";
import BrowserLlmDownloadConstants from "../../Constants/BrowserLlmDownloadConstants.js";
import BrowserLlmCapability from "./BrowserLlmCapability.js";
import BrowserLlmDownloadManager from "./BrowserLlmDownloadManager.js";
import DialogBox from "../../../CommonComponents/DialogBox.js";
import UserIdentityManager from "../UserIdentityManager.js";
import PreferredModelTier from "./PreferredModelTier.js";


/**
 * BrowserLlmDownloadBootstrap
 *
 * Once per session, when both:
 *
 *   - `InitializationEvents.COMPLETE` has fired (Deck tree booted), and
 *   - `AuthenticationEvents.ON_USER_LOGGED_IN` has fired (real user,
 *     not anonymous),
 *
 * check whether the Free-tier model should be offered. Conditions:
 *
 *   1. WebGPU is available on this device.
 *   2. State is NOT_STARTED (no prior decline, no prior success, no
 *      prior failure surfaced).
 *
 * Both conditions met → prompt with a Cancel/OK dialog explaining the
 * ~2 GB background download. Accept → start. Decline → record the
 * declined flag so we never re-prompt on this device.
 *
 * UNSUPPORTED / DECLINED / DOWNLOADING / READY / FAILED all short-circuit
 * here — the user's choices on the tier dropdown are the recovery
 * surface for those.
 *
 * The static initialiser registers the listeners exactly once. Calls
 * to setIdentity for the same logged-in user are idempotent — the
 * `#bAlreadyPromptedThisSession` guard prevents double-prompts when
 * a session is refreshed.
 */
class BrowserLlmDownloadBootstrap
{
    static #bInitializationComplete = false;
    static #bUserLoggedIn = false;
    static #bAlreadyPromptedThisSession = false;

    static
    {
        console.log("[BrowserLlmDownloadBootstrap] Static initialiser running.");

        window.addEventListener(InitializationEvents.COMPLETE, () =>
        {
            BrowserLlmDownloadBootstrap.#bInitializationComplete = true;
            BrowserLlmDownloadBootstrap.#tryPrompt();
        });

        window.addEventListener(AuthenticationEvents.ON_USER_LOGGED_IN, () =>
        {
            BrowserLlmDownloadBootstrap.#bUserLoggedIn = true;
            BrowserLlmDownloadBootstrap.#tryPrompt();
        });

        window.addEventListener(AuthenticationEvents.ON_USER_LOGGED_OUT, () =>
        {
            BrowserLlmDownloadBootstrap.#bUserLoggedIn = false;
            BrowserLlmDownloadBootstrap.#bAlreadyPromptedThisSession = false;
        });

        // Kick off the preferred-tier hydration right away — separate
        // from the prompt flow, but needed by the tier dropdown the
        // first time the user opens the text-selection menu.
        PreferredModelTier.hydrate();
    }

    static async #tryPrompt()
    {
        if (!BrowserLlmDownloadBootstrap.#bInitializationComplete) return;
        if (!BrowserLlmDownloadBootstrap.#bUserLoggedIn) return;
        if (BrowserLlmDownloadBootstrap.#bAlreadyPromptedThisSession) return;

        // Anonymous identity has no per-account persisted state we want
        // to disturb. Skip the prompt entirely for anonymous sessions.
        if (UserIdentityManager.isAnonymous())
        {
            return;
        }

        BrowserLlmDownloadBootstrap.#bAlreadyPromptedThisSession = true;

        await BrowserLlmCapability.initialize();
        const currentState = BrowserLlmCapability.getState();

        if (currentState !== browserLlmDownloadStates.NOT_STARTED)
        {
            // Nothing to do — either we can't run the model on this
            // device, the user has already chosen, or the model is
            // ready / in-flight.
            return;
        }

        const acceptedDownload = await DialogBox.confirm(
            "Download the offline AI model?",
            [
                `MindMeld can run a small AI model locally on this device for the Free tier — no internet needed once it's installed.`,
                ``,
                `The download is ${BrowserLlmDownloadConstants.ESTIMATED_TOTAL_LABEL} and happens in the background. You can keep studying — the model becomes available the moment it's ready.`,
                ``,
                `Choose Cancel to skip for now; you can start the download anytime from the Free row of the model picker.`
            ].join("<br>")
        );

        if (acceptedDownload)
        {
            // Fire-and-forget — the manager already wires up progress +
            // completion + failure events; we don't need to await it.
            BrowserLlmDownloadManager.start();
        }
        else
        {
            await BrowserLlmDownloadManager.decline();
        }
    }
}

export default BrowserLlmDownloadBootstrap;
