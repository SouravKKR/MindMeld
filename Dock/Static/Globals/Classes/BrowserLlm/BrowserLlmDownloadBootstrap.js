import AuthenticationEvents from "../../Events/AuthenticationEvents.js";
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
 * Step 3 of `LoginPopupSequence`. Invoked once the legal modal and the
 * Beginners tutorial have both resolved. Checks whether the Free-tier
 * model should be offered on this device. Conditions:
 *
 *   1. WebGPU is available — without `navigator.gpu` the model can't
 *      run, so `BrowserLlmCapability.initialize()` pins the state to
 *      UNSUPPORTED and this step short-circuits without showing
 *      anything. (This is the "show only if the device is compatible"
 *      gate.)
 *   2. State is NOT_STARTED — i.e. the user hasn't already accepted,
 *      declined, succeeded, or failed on this device.
 *
 * Both met → DialogBox.confirm with a ~2 GB background-download
 * explanation. Accept → start. Decline → persist the declined flag so
 * we never re-prompt on this device.
 *
 * Independent of the welcome chain: `PreferredModelTier.hydrate()` is
 * kicked off at module-load time because the tier dropdown reads it the
 * first time the user opens the text-selection menu — that can happen
 * before the welcome chain finishes.
 */
class BrowserLlmDownloadBootstrap
{
    static #bAlreadyPromptedThisSession = false;

    static
    {
        // Tier-dropdown hydration is independent of the welcome chain
        // and needs to run early so the dropdown has data the first
        // time the user opens it.
        PreferredModelTier.hydrate();

        // Reset the once-per-session guard on logout so re-login within
        // the same page lifecycle can re-prompt where applicable.
        window.addEventListener(AuthenticationEvents.ON_USER_LOGGED_OUT, () =>
        {
            BrowserLlmDownloadBootstrap.#bAlreadyPromptedThisSession = false;
        });
    }

    /**
     * Public entry point invoked by LoginPopupSequence. Resolves once
     * the prompt has been answered (or skipped because the device is
     * incompatible / the user has already chosen on this device). Never
     * throws — DialogBox.confirm's promise resolves on both buttons,
     * and the persistence calls inside the manager swallow their own
     * errors.
     */
    static async runForLogin(user)
    {
        if (!user)
        {
            return;
        }

        if (BrowserLlmDownloadBootstrap.#bAlreadyPromptedThisSession)
        {
            return;
        }

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
            // Nothing to do — either the device is incompatible (no
            // WebGPU), the user has already chosen, or the model is
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
