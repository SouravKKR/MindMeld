import { localLlmDownloadStates } from "../../Enumerations/LocalLlmDownloadStates.js";
import { localLlmUnavailableReasons } from "../../Enumerations/LocalLlmUnavailableReasons.js";
import LocalLlmDownloadConstants from "../../Constants/LocalLlmDownloadConstants.js";
import LocalLlmDownloadEvents from "../../Events/LocalLlmDownloadEvents.js";
import LocalLlmDeviceProbe from "./LocalLlmDeviceProbe.js";
import LocalLlmManifestClient from "./LocalLlmManifestClient.js";
import LocalLlmModelSelector from "./LocalLlmModelSelector.js";
import LocalLlmSessionController from "./LocalLlmSessionController.js";
import Persistence from "../Persistence.js";
import UserIdentityManager from "../UserIdentityManager.js";
import UserIdentityConstants from "../../Constants/UserIdentityConstants.js";
import { dataFormats } from "../../Enumerations/DataFormats.js";


/**
 * LocalLlmCapability
 *
 * Single source of truth for whether the in-browser Free-tier model can be
 * used on this device, and which model that would be. The state is one of
 * `localLlmDownloadStates` and is derived from three inputs:
 *
 *   1. What LocalLlmSessionController resolves — the device's real
 *      capabilities matched against the models this server has provisioned.
 *      When no model fits, the specific `localLlmUnavailableReasons` value
 *      is kept so the learner is told which wall they hit.
 *   2. A persisted DECLINED flag (per device, written by
 *      LocalLlmDownloadManager.decline()) — the "no thanks, but here's a
 *      retry" case.
 *   3. A persisted download-state record (per device) carrying
 *      { state, modelKey, fraction, lastTransitionAt }.
 *
 * The persisted MODEL KEY matters as much as the state. A READY record proves
 * a particular model's weights are in the browser cache — if the resolved
 * model has since changed (the server provisioned a better one, or the
 * learner opened the app on different hardware) those cached weights are for
 * something else, so READY is demoted rather than trusted.
 *
 * Hydration is async (a WebGPU adapter request, a manifest fetch and a
 * Persistence read), so callers await `initialize()` once at boot. After that
 * `getState()` and `getDisabledReasonText()` are synchronous.
 */
class LocalLlmCapability
{
    static #state = localLlmDownloadStates.NOT_STARTED;

    // Diagnostic-only. What was on disk when this session started, and which
    // identity prefix it was read under. Never drives behaviour.
    static #persistedStateAtBoot = null;
    static #storagePrefixAtBoot = null;
    static #progressFraction = 0;
    static #bInitialized = false;
    static #initializePromise = null;
    static #lastError = null;
    static #selectionOutcome = null;

    /**
     * Resolves the device's model selection against the persisted state and
     * declined flag, then seeds the in-memory cache. Safe to await more than
     * once — repeated calls share the same in-flight promise.
     */
    static initialize()
    {
        if (LocalLlmCapability.#initializePromise)
        {
            return LocalLlmCapability.#initializePromise;
        }

        LocalLlmCapability.#initializePromise = (async () =>
        {
            const persistedState = await LocalLlmCapability.#readPersistedState();
            const bUserDeclined = await LocalLlmCapability.#readDeclinedFlag();

            // Diagnostic snapshot, taken before anything reconciles it away.
            // "Why is it asking me to download again?" is otherwise
            // unanswerable from the outside: the record either did not exist,
            // named a different model, or said DOWNLOADING — three very
            // different faults that all render as the same NOT_STARTED line.
            LocalLlmCapability.#persistedStateAtBoot = persistedState;
            LocalLlmCapability.#storagePrefixAtBoot = UserIdentityManager.getStoragePrefix();

            let selectionOutcome = null;
            try
            {
                selectionOutcome = await LocalLlmSessionController.resolveSelectionOutcome();
            }
            catch (resolveError)
            {
                console.warn(`[LocalLlmCapability] Could not resolve a model: ${resolveError?.message || resolveError}`);
            }
            LocalLlmCapability.#selectionOutcome = selectionOutcome;

            if (!selectionOutcome || !selectionOutcome.isAvailable())
            {
                // Being offline must not revoke a model already sitting in the
                // browser cache — running without a network is the entire
                // premise of this tier. Only a reachable server saying "no
                // model fits this device" is grounds for UNSUPPORTED.
                const bManifestUnreachable = LocalLlmManifestClient.didLastFetchFail();
                if (bManifestUnreachable && persistedState && persistedState.state === localLlmDownloadStates.READY)
                {
                    LocalLlmCapability.#state = localLlmDownloadStates.READY;
                    LocalLlmCapability.#progressFraction = 1;
                }
                else
                {
                    LocalLlmCapability.#state = localLlmDownloadStates.UNSUPPORTED;
                }
                LocalLlmCapability.#bInitialized = true;
                return;
            }

            // The user's explicit choice trumps an interrupted download whose
            // last on-disk state was DOWNLOADING.
            if (bUserDeclined)
            {
                LocalLlmCapability.#state = localLlmDownloadStates.DECLINED;
            }
            else if (persistedState && typeof persistedState.state === "number")
            {
                LocalLlmCapability.#state = LocalLlmCapability.#reconcilePersistedState(persistedState, selectionOutcome);
                LocalLlmCapability.#progressFraction = typeof persistedState.fraction === "number"
                    ? persistedState.fraction
                    : 0;
            }
            else
            {
                LocalLlmCapability.#state = localLlmDownloadStates.NOT_STARTED;
            }

            LocalLlmCapability.#bInitialized = true;
            console.log(`[LocalLlmCapability] ${LocalLlmCapability.getDiagnosticText()}`);
        })();

        return LocalLlmCapability.#initializePromise;
    }

    /**
     * Decides what a persisted record still means now that the device's model
     * has been re-resolved.
     */
    static #reconcilePersistedState(persistedState, selectionOutcome)
    {
        // A DOWNLOADING record means the previous session was killed
        // mid-fetch. How much survived in the cache is unknown, so the
        // learner explicitly retriggers.
        if (persistedState.state === localLlmDownloadStates.DOWNLOADING)
        {
            return localLlmDownloadStates.NOT_STARTED;
        }

        // A READY record for a different model is not evidence about this
        // one. Its weights are still cached and will be reused if the app
        // ever selects it again, so nothing is lost by starting over here.
        if (persistedState.state === localLlmDownloadStates.READY
            && persistedState.modelKey
            && persistedState.modelKey !== selectionOutcome.getModelKey())
        {
            console.log(`[LocalLlmCapability] Cached model "${persistedState.modelKey}" no longer matches the resolved "${selectionOutcome.getModelKey()}" — re-downloading.`);
            return localLlmDownloadStates.NOT_STARTED;
        }

        // An UNSUPPORTED record cannot survive a successful resolution: the
        // server may have provisioned a model that fits since it was written.
        if (persistedState.state === localLlmDownloadStates.UNSUPPORTED)
        {
            return localLlmDownloadStates.NOT_STARTED;
        }

        return persistedState.state;
    }

    /**
     * Human-readable account of why this session believes what it believes
     * about the on-device model. Purely descriptive — nothing reads it back.
     *
     * It answers the one question the status line cannot: a model that is
     * physically present can still report NOT_STARTED because the record was
     * absent, named a different model, or was left mid-download, and those
     * need different fixes.
     */
    static getDiagnosticText()
    {
        const stateName = LocalLlmCapability.#nameForState(LocalLlmCapability.#state);
        const resolvedModelKey = LocalLlmCapability.getSelectedModelKey() || "none";
        const persistedRecord = LocalLlmCapability.#persistedStateAtBoot;

        const persistedDescription = persistedRecord && typeof persistedRecord.state === "number"
            ? `${LocalLlmCapability.#nameForState(persistedRecord.state)}(${persistedRecord.modelKey || "no model key"})`
            : "no record on disk";

        // Whether the record escaped the per-identity prefix. Reported rather
        // than assumed: the fix is one entry in a Set built at class-init
        // time, and if that entry ever resolves to undefined it fails
        // silently — the record goes back to being per-user and the repeat
        // download returns with nothing to show for it.
        const bRecordIsDeviceScoped = UserIdentityConstants.GLOBAL_KEYS.has(
            LocalLlmDownloadConstants.LOCAL_STATE_PERSISTENCE_KEY
        );

        // The device's real WebGPU ceilings, next to what the chosen model
        // demands. Android reports a far smaller maxStorageBufferBindingSize
        // than desktop (mlc-ai/web-llm#209 — a Pixel 7 reports 128 MB against a
        // 1 GB requirement), and when a graphics model is selected anyway the
        // load dies somewhere inside the engine and resurfaces later as
        // "Model not loaded before trying to complete ChatCompletionRequest",
        // which names neither the device nor the limit that actually stopped it.
        const deviceProfile = LocalLlmDeviceProbe.getCachedProfile();
        const gpuDescription = deviceProfile
            ? `maxStorageBinding=${LocalLlmCapability.#megabytes(deviceProfile.getMaxStorageBufferBindingSizeBytes())}`
                + `/maxBuffer=${LocalLlmCapability.#megabytes(deviceProfile.getMaxBufferSizeBytes())}`
                + `/memory=${deviceProfile.getDeviceMemoryGigabytes() || "?"}GB`
            : "no probe";

        return `state=${stateName} · resolved=${resolvedModelKey} · onDisk=${persistedDescription}`
            + ` · prefix=${LocalLlmCapability.#storagePrefixAtBoot || "unknown"}`
            + ` · deviceScoped=${bRecordIsDeviceScoped ? "yes" : "NO"}`
            + ` · gpu=${gpuDescription}`;
    }

    static #megabytes(byteCount)
    {
        if (typeof byteCount !== "number" || byteCount <= 0)
        {
            return "0MB";
        }
        return `${Math.round(byteCount / 1048576)}MB`;
    }

    static #nameForState(stateValue)
    {
        for (const [name, value] of Object.entries(localLlmDownloadStates))
        {
            if (value === stateValue)
            {
                return name;
            }
        }
        return String(stateValue);
    }

    /**
     * Every model this device could run, best first — what the Settings chooser
     * offers.
     *
     * Delegated to the selector rather than filtered here. The rule about what
     * a device may run is already written once, and a second copy in the
     * capability layer would be the one nobody exercises: it would drift, and
     * the symptom would be a chooser offering a model the selector then refuses
     * to load.
     */
    static async listEligibleModels()
    {
        try
        {
            const deviceProfile = await LocalLlmDeviceProbe.probe();
            await LocalLlmManifestClient.fetchDescriptors();

            return LocalLlmModelSelector.listEligibleModels(
                deviceProfile,
                LocalLlmManifestClient.getAvailableModelKeys()
            );
        }
        catch (listError)
        {
            console.warn(`[LocalLlmCapability] Could not list the eligible models: ${listError?.message || listError}`);
            return [];
        }
    }

    /**
     * Re-runs resolution after the learner changes which model they want.
     *
     * The engine is released as well, because the loaded weights are the OLD
     * model's. Leaving it would answer the next question from a model the
     * settings page says is no longer selected — the worst kind of wrong, since
     * nothing about the answer would look off.
     *
     * The download state is then re-read against the new choice: if its weights
     * are already present it is READY immediately, and if not the picker drops
     * back to "click to download" for that model rather than reporting the tier
     * broken.
     */
    static async reresolve()
    {
        LocalLlmSessionController.release();

        LocalLlmCapability.#bInitialized = false;
        LocalLlmCapability.#initializePromise = null;

        await LocalLlmCapability.initialize();

        window.dispatchEvent(new CustomEvent(LocalLlmDownloadEvents.CAPABILITY_CHANGED,
        {
            detail: { state: LocalLlmCapability.#state }
        }));
    }

    static getState()
    {
        return LocalLlmCapability.#state;
    }

    static getProgressFraction()
    {
        return LocalLlmCapability.#progressFraction;
    }

    static getLastError()
    {
        return LocalLlmCapability.#lastError;
    }

    static isInitialized()
    {
        return LocalLlmCapability.#bInitialized;
    }

    static getSelectionOutcome()
    {
        return LocalLlmCapability.#selectionOutcome;
    }

    /**
     * The catalogue key this device resolved to, or null when none fits.
     */
    static getSelectedModelKey()
    {
        return LocalLlmCapability.#selectionOutcome ? LocalLlmCapability.#selectionOutcome.getModelKey() : null;
    }

    /**
     * The merged manifest descriptor for the selected model, or null.
     */
    static getSelectedDescriptor()
    {
        const modelKey = LocalLlmCapability.getSelectedModelKey();
        return modelKey ? LocalLlmManifestClient.getDescriptor(modelKey) : null;
    }

    /**
     * Real byte count for the selected model when the server reported one,
     * falling back to the catalogue's estimate. Drives the download bar.
     */
    static getEstimatedTotalBytes()
    {
        const descriptor = LocalLlmCapability.getSelectedDescriptor();
        return descriptor && Number.isFinite(descriptor.totalBytes) ? descriptor.totalBytes : 0;
    }

    static getEstimatedTotalLabel()
    {
        const descriptor = LocalLlmCapability.getSelectedDescriptor();
        return descriptor ? descriptor.approximateTotalLabel : "";
    }

    /**
     * Short label for the selected model, e.g. "1.5B" or "0.5B", so the tier
     * picker can name what this device actually got.
     */
    static getSelectedParameterLabel()
    {
        const descriptor = LocalLlmCapability.getSelectedDescriptor();
        return descriptor ? descriptor.parameterLabel : "";
    }

    static isSelectedModelProcessorBacked()
    {
        const descriptor = LocalLlmCapability.getSelectedDescriptor();
        return Boolean(descriptor && descriptor.executionBackend === "WASM");
    }

    /**
     * Update the cached state, persist it (best-effort), and broadcast a
     * CAPABILITY_CHANGED event so the picker and activity surfaces re-render.
     */
    static async setState(newState, extra = {})
    {
        LocalLlmCapability.#state = newState;

        if (typeof extra.fraction === "number")
        {
            LocalLlmCapability.#progressFraction = extra.fraction;
        }
        if (extra.error !== undefined)
        {
            LocalLlmCapability.#lastError = extra.error;
        }

        await LocalLlmCapability.#writePersistedState(
        {
            state: newState,
            modelKey: LocalLlmCapability.getSelectedModelKey(),
            fraction: LocalLlmCapability.#progressFraction,
            errorMessage: LocalLlmCapability.#lastError ? String(LocalLlmCapability.#lastError) : null,
            lastTransitionAt: Date.now(),
        });

        window.dispatchEvent(new CustomEvent(LocalLlmDownloadEvents.CAPABILITY_CHANGED,
        {
            detail: { state: newState }
        }));
    }

    /**
     * Update progress without changing state. Cheaper than setState because
     * we don't re-persist on every tick — the fraction is flushed on the next
     * state change.
     */
    static updateProgress(fraction)
    {
        LocalLlmCapability.#progressFraction = fraction;
    }

    static async setDeclined(bDeclined)
    {
        await Persistence.write(
            LocalLlmDownloadConstants.LOCAL_DECLINED_PERSISTENCE_KEY,
            { declined: bDeclined === true, at: Date.now() },
            dataFormats.JSON
        );
    }

    /**
     * One human-readable reason the Free tier is unavailable, for the tier
     * picker's status line. Returns null when the tier is fully usable.
     *
     * UNSUPPORTED is deliberately not one message: "your browser has no
     * graphics acceleration and no WebAssembly" and "this server hasn't
     * installed a model yet" need completely different responses from the
     * reader, and collapsing them is what made the old single message
     * useless.
     */
    static getDisabledReasonText()
    {
        switch (LocalLlmCapability.#state)
        {
            case localLlmDownloadStates.UNSUPPORTED:
                return LocalLlmCapability.#buildUnavailableReasonText();

            case localLlmDownloadStates.NOT_STARTED:
            {
                const sizeLabel = LocalLlmCapability.getEstimatedTotalLabel();
                const modelLabel = LocalLlmCapability.getSelectedParameterLabel();
                const sizeClause = sizeLabel ? ` (${modelLabel}, ${sizeLabel})` : "";
                return `Free needs its AI model on this device${sizeClause}. Click to start the download.`;
            }

            case localLlmDownloadStates.DOWNLOADING:
            {
                const percent = Math.round(Math.max(0, Math.min(1, LocalLlmCapability.#progressFraction)) * 100);
                return `Downloading the on-device AI model… ${percent}%. Please wait.`;
            }

            case localLlmDownloadStates.DECLINED:
                return "Download was declined. Click to download it now.";

            case localLlmDownloadStates.FAILED:
            {
                const detail = LocalLlmCapability.#lastError ? ` (${LocalLlmCapability.#lastError})` : "";
                return `Download failed${detail}. Click to retry.`;
            }

            case localLlmDownloadStates.READY:
                return null;

            default: return "Free tier is unavailable right now.";
        }
    }

    static #buildUnavailableReasonText()
    {
        const unavailableReason = LocalLlmCapability.#selectionOutcome
            ? LocalLlmCapability.#selectionOutcome.getUnavailableReason()
            : localLlmUnavailableReasons.NO_MODEL_PROVISIONED;

        switch (unavailableReason)
        {
            // Phrased as a route rather than a refusal, because it now is one.
            // The same phone that cannot run this in a browser runs it in the
            // app: compiled code with the app in the foreground is a different
            // proposition from a background tab driving the graphics stack.
            // Telling a learner "your device can't" when the honest answer is
            // "not in a browser" sends them to a paid tier they did not need.
            case localLlmUnavailableReasons.HANDHELD_DEVICE:
                return "Free runs its AI model on your device. In a phone or tablet browser that isn't reliable, but it works in the CogniumLearn app — install the app to use Free here, or pick Basic, Pro or Pro Plus.";

            case localLlmUnavailableReasons.NO_SUPPORTED_BACKEND:
                return "This browser can't run an AI model locally — it has no graphics acceleration (WebGPU). The CogniumLearn app runs the model without needing it, or you can pick Basic, Pro or Pro Plus.";

            case localLlmUnavailableReasons.GPU_LIMITS_TOO_LOW:
                return "This device's graphics hardware is below what the smallest available model needs. Pick Basic, Pro or Pro Plus instead.";

            case localLlmUnavailableReasons.DEVICE_MEMORY_TOO_LOW:
                return "This device doesn't report enough memory to run an AI model locally. Pick Basic, Pro or Pro Plus instead.";

            case localLlmUnavailableReasons.NO_MODEL_PROVISIONED:
                return "No on-device AI model is installed on this server yet, so the Free tier can't run. Pick Basic, Pro or Pro Plus for now.";

            case localLlmUnavailableReasons.MANIFEST_UNREACHABLE:
                return "Couldn't check which on-device AI model is available. Reconnect and try again.";

            default: return "The Free tier can't run on this device. Pick Basic, Pro or Pro Plus instead.";
        }
    }

    /**
     * One plain sentence about the compromise this device is running under —
     * the processor backend, or a smaller model than the server offers — or
     * null when it got the best available. Shown alongside the picker so a
     * learner knows why answers differ from another device.
     */
    static getSelectionNoteText()
    {
        return LocalLlmCapability.#selectionOutcome
            ? LocalLlmCapability.#selectionOutcome.getHonestNote()
            : null;
    }

    /**
     * True when clicking the disabled Free row should trigger a download or
     * retry — i.e. the learner can recover by their own action. False for
     * UNSUPPORTED (nothing to recover) and DOWNLOADING (already running).
     */
    static isRecoverableByUser()
    {
        return LocalLlmCapability.#state === localLlmDownloadStates.NOT_STARTED
            || LocalLlmCapability.#state === localLlmDownloadStates.DECLINED
            || LocalLlmCapability.#state === localLlmDownloadStates.FAILED;
    }

    static async #readPersistedState()
    {
        try
        {
            const exists = await Persistence.exists(LocalLlmDownloadConstants.LOCAL_STATE_PERSISTENCE_KEY);
            if (!exists)
            {
                return null;
            }
            return await Persistence.read(LocalLlmDownloadConstants.LOCAL_STATE_PERSISTENCE_KEY, dataFormats.JSON);
        }
        catch (readError)
        {
            console.warn(`[LocalLlmCapability] Could not read persisted state: ${readError?.message || readError}`);
            return null;
        }
    }

    static async #readDeclinedFlag()
    {
        try
        {
            const exists = await Persistence.exists(LocalLlmDownloadConstants.LOCAL_DECLINED_PERSISTENCE_KEY);
            if (!exists)
            {
                return false;
            }
            const record = await Persistence.read(LocalLlmDownloadConstants.LOCAL_DECLINED_PERSISTENCE_KEY, dataFormats.JSON);
            return record?.declined === true;
        }
        catch (readError)
        {
            console.warn(`[LocalLlmCapability] Could not read declined flag: ${readError?.message || readError}`);
            return false;
        }
    }

    static async #writePersistedState(record)
    {
        try
        {
            await Persistence.write(LocalLlmDownloadConstants.LOCAL_STATE_PERSISTENCE_KEY, record, dataFormats.JSON);
        }
        catch (writeError)
        {
            console.warn(`[LocalLlmCapability] Could not persist state: ${writeError?.message || writeError}`);
        }
    }
}

export default LocalLlmCapability;
