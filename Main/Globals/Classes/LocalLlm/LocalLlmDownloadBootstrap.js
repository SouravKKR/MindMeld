import AuthenticationEvents from "../../Events/AuthenticationEvents.js";
import { localLlmDownloadStates } from "../../Enumerations/LocalLlmDownloadStates.js";
import LocalLlmCapability from "./LocalLlmCapability.js";
import LocalLlmDownloadManager from "./LocalLlmDownloadManager.js";
import DialogBox from "../../../CommonComponents/DialogBox.js";
import UserIdentityManager from "../UserIdentityManager.js";
import PreferredModelTier from "./PreferredModelTier.js";


/**
 * LocalLlmDownloadBootstrap
 *
 * Boot-time setup for the offline-model subsystem. Its static block runs
 * at module load and (a) hydrates `PreferredModelTier` and (b) resolves
 * `LocalLlmCapability` — so the tier dropdown and the Activity feed
 * have accurate state the first time they render, before any user action.
 *
 * `runForLogin(user)` shows the legacy login-time "Download the offline
 * AI model?" confirm dialog. It is intentionally NO LONGER wired into
 * `LoginPopupSequence` — the download is offered on demand from
 * Settings ▸ AI (the Free row of the model picker) instead. The method is
 * kept (dormant) so the login-time prompt can be re-enabled without
 * resurrecting code; it self-gates on capability (UNSUPPORTED → no-op)
 * and on the state being NOT_STARTED.
 */
class LocalLlmDownloadBootstrap
{
    static #bAlreadyPromptedThisSession = false;

    static
    {
        // Tier-dropdown hydration is independent of the welcome chain
        // and needs to run early so the dropdown has data the first
        // time the user opens it.
        PreferredModelTier.hydrate();

        // Resolve offline-model capability + persisted download state at
        // boot so every surface that reads LocalLlmCapability.getState()
        // (the model picker, the Activity feed) is accurate without
        // waiting for a user action. This is what runForLogin used to
        // trigger; now that the login-time prompt is gone (the download is
        // offered on demand from Settings ▸ AI), it runs here at module
        // load instead. initialize() shares one in-flight promise.
        LocalLlmCapability.initialize();

        // Reset the once-per-session guard on logout so re-login within
        // the same page lifecycle can re-prompt where applicable.
        window.addEventListener(AuthenticationEvents.ON_USER_LOGGED_OUT, () =>
        {
            LocalLlmDownloadBootstrap.#bAlreadyPromptedThisSession = false;
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

        if (LocalLlmDownloadBootstrap.#bAlreadyPromptedThisSession)
        {
            return;
        }

        // Anonymous identity has no per-account persisted state we want
        // to disturb. Skip the prompt entirely for anonymous sessions.
        if (UserIdentityManager.isAnonymous())
        {
            return;
        }

        LocalLlmDownloadBootstrap.#bAlreadyPromptedThisSession = true;

        await LocalLlmCapability.initialize();
        const currentState = LocalLlmCapability.getState();

        if (currentState !== localLlmDownloadStates.NOT_STARTED)
        {
            // Nothing to do — either the device is incompatible (no
            // WebGPU), the user has already chosen, or the model is
            // ready / in-flight.
            return;
        }

        const acceptedDownload = await DialogBox.confirm(
            "Download the offline AI model?",
            [
                `CogniumLearn can run a small AI model locally on this device for the Free tier — no internet needed once it's installed.`,
                ``,
                `The download is ${LocalLlmCapability.getEstimatedTotalLabel() || "several hundred megabytes"} and happens in the background. You can keep studying — the model becomes available the moment it's ready.`,
                ``,
                `Choose Cancel to skip for now; you can start the download anytime from the Free row of the model picker.`
            ].join("<br>")
        );

        if (acceptedDownload)
        {
            // Fire-and-forget — the manager already wires up progress +
            // completion + failure events; we don't need to await it.
            LocalLlmDownloadManager.start();
        }
        else
        {
            await LocalLlmDownloadManager.decline();
        }
    }
}

export default LocalLlmDownloadBootstrap;
