import { browserLlmDownloadStates } from "../../Enumerations/BrowserLlmDownloadStates.js";
import { browserLlmUnavailableReasons } from "../../Enumerations/BrowserLlmUnavailableReasons.js";
import BrowserLlmDownloadConstants from "../../Constants/BrowserLlmDownloadConstants.js";
import BrowserLlmDownloadEvents from "../../Events/BrowserLlmDownloadEvents.js";
import BrowserLlmDeviceProbe from "./BrowserLlmDeviceProbe.js";
import BrowserLlmManifestClient from "./BrowserLlmManifestClient.js";
import BrowserLlmSessionController from "./BrowserLlmSessionController.js";
import Persistence from "../Persistence.js";
import UserIdentityManager from "../UserIdentityManager.js";
import UserIdentityConstants from "../../Constants/UserIdentityConstants.js";
import { dataFormats } from "../../Enumerations/DataFormats.js";


/**
 * BrowserLlmCapability
 *
 * Single source of truth for whether the in-browser Free-tier model can be
 * used on this device, and which model that would be. The state is one of
 * `browserLlmDownloadStates` and is derived from three inputs:
 *
 *   1. What BrowserLlmSessionController resolves — the device's real
 *      capabilities matched against the models this server has provisioned.
 *      When no model fits, the specific `browserLlmUnavailableReasons` value
 *      is kept so the learner is told which wall they hit.
 *   2. A persisted DECLINED flag (per device, written by
 *      BrowserLlmDownloadManager.decline()) — the "no thanks, but here's a
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
class BrowserLlmCapability
{
    static #state = browserLlmDownloadStates.NOT_STARTED;

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
        if (BrowserLlmCapability.#initializePromise)
        {
            return BrowserLlmCapability.#initializePromise;
        }

        BrowserLlmCapability.#initializePromise = (async () =>
        {
            const persistedState = await BrowserLlmCapability.#readPersistedState();
            const bUserDeclined = await BrowserLlmCapability.#readDeclinedFlag();

            // Diagnostic snapshot, taken before anything reconciles it away.
            // "Why is it asking me to download again?" is otherwise
            // unanswerable from the outside: the record either did not exist,
            // named a different model, or said DOWNLOADING — three very
            // different faults that all render as the same NOT_STARTED line.
            BrowserLlmCapability.#persistedStateAtBoot = persistedState;
            BrowserLlmCapability.#storagePrefixAtBoot = UserIdentityManager.getStoragePrefix();

            let selectionOutcome = null;
            try
            {
                selectionOutcome = await BrowserLlmSessionController.resolveSelectionOutcome();
            }
            catch (resolveError)
            {
                console.warn(`[BrowserLlmCapability] Could not resolve a model: ${resolveError?.message || resolveError}`);
            }
            BrowserLlmCapability.#selectionOutcome = selectionOutcome;

            if (!selectionOutcome || !selectionOutcome.isAvailable())
            {
                // Being offline must not revoke a model already sitting in the
                // browser cache — running without a network is the entire
                // premise of this tier. Only a reachable server saying "no
                // model fits this device" is grounds for UNSUPPORTED.
                const bManifestUnreachable = BrowserLlmManifestClient.didLastFetchFail();
                if (bManifestUnreachable && persistedState && persistedState.state === browserLlmDownloadStates.READY)
                {
                    BrowserLlmCapability.#state = browserLlmDownloadStates.READY;
                    BrowserLlmCapability.#progressFraction = 1;
                }
                else
                {
                    BrowserLlmCapability.#state = browserLlmDownloadStates.UNSUPPORTED;
                }
                BrowserLlmCapability.#bInitialized = true;
                return;
            }

            // The user's explicit choice trumps an interrupted download whose
            // last on-disk state was DOWNLOADING.
            if (bUserDeclined)
            {
                BrowserLlmCapability.#state = browserLlmDownloadStates.DECLINED;
            }
            else if (persistedState && typeof persistedState.state === "number")
            {
                BrowserLlmCapability.#state = BrowserLlmCapability.#reconcilePersistedState(persistedState, selectionOutcome);
                BrowserLlmCapability.#progressFraction = typeof persistedState.fraction === "number"
                    ? persistedState.fraction
                    : 0;
            }
            else
            {
                BrowserLlmCapability.#state = browserLlmDownloadStates.NOT_STARTED;
            }

            BrowserLlmCapability.#bInitialized = true;
            console.log(`[BrowserLlmCapability] ${BrowserLlmCapability.getDiagnosticText()}`);
        })();

        return BrowserLlmCapability.#initializePromise;
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
        if (persistedState.state === browserLlmDownloadStates.DOWNLOADING)
        {
            return browserLlmDownloadStates.NOT_STARTED;
        }

        // A READY record for a different model is not evidence about this
        // one. Its weights are still cached and will be reused if the app
        // ever selects it again, so nothing is lost by starting over here.
        if (persistedState.state === browserLlmDownloadStates.READY
            && persistedState.modelKey
            && persistedState.modelKey !== selectionOutcome.getModelKey())
        {
            console.log(`[BrowserLlmCapability] Cached model "${persistedState.modelKey}" no longer matches the resolved "${selectionOutcome.getModelKey()}" — re-downloading.`);
            return browserLlmDownloadStates.NOT_STARTED;
        }

        // An UNSUPPORTED record cannot survive a successful resolution: the
        // server may have provisioned a model that fits since it was written.
        if (persistedState.state === browserLlmDownloadStates.UNSUPPORTED)
        {
            return browserLlmDownloadStates.NOT_STARTED;
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
        const stateName = BrowserLlmCapability.#nameForState(BrowserLlmCapability.#state);
        const resolvedModelKey = BrowserLlmCapability.getSelectedModelKey() || "none";
        const persistedRecord = BrowserLlmCapability.#persistedStateAtBoot;

        const persistedDescription = persistedRecord && typeof persistedRecord.state === "number"
            ? `${BrowserLlmCapability.#nameForState(persistedRecord.state)}(${persistedRecord.modelKey || "no model key"})`
            : "no record on disk";

        // Whether the record escaped the per-identity prefix. Reported rather
        // than assumed: the fix is one entry in a Set built at class-init
        // time, and if that entry ever resolves to undefined it fails
        // silently — the record goes back to being per-user and the repeat
        // download returns with nothing to show for it.
        const bRecordIsDeviceScoped = UserIdentityConstants.GLOBAL_KEYS.has(
            BrowserLlmDownloadConstants.LOCAL_STATE_PERSISTENCE_KEY
        );

        // The device's real WebGPU ceilings, next to what the chosen model
        // demands. Android reports a far smaller maxStorageBufferBindingSize
        // than desktop (mlc-ai/web-llm#209 — a Pixel 7 reports 128 MB against a
        // 1 GB requirement), and when a graphics model is selected anyway the
        // load dies somewhere inside the engine and resurfaces later as
        // "Model not loaded before trying to complete ChatCompletionRequest",
        // which names neither the device nor the limit that actually stopped it.
        const deviceProfile = BrowserLlmDeviceProbe.getCachedProfile();
        const gpuDescription = deviceProfile
            ? `maxStorageBinding=${BrowserLlmCapability.#megabytes(deviceProfile.getMaxStorageBufferBindingSizeBytes())}`
                + `/maxBuffer=${BrowserLlmCapability.#megabytes(deviceProfile.getMaxBufferSizeBytes())}`
                + `/memory=${deviceProfile.getDeviceMemoryGigabytes() || "?"}GB`
            : "no probe";

        return `state=${stateName} · resolved=${resolvedModelKey} · onDisk=${persistedDescription}`
            + ` · prefix=${BrowserLlmCapability.#storagePrefixAtBoot || "unknown"}`
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
        for (const [name, value] of Object.entries(browserLlmDownloadStates))
        {
            if (value === stateValue)
            {
                return name;
            }
        }
        return String(stateValue);
    }

    static getState()
    {
        return BrowserLlmCapability.#state;
    }

    static getProgressFraction()
    {
        return BrowserLlmCapability.#progressFraction;
    }

    static getLastError()
    {
        return BrowserLlmCapability.#lastError;
    }

    static isInitialized()
    {
        return BrowserLlmCapability.#bInitialized;
    }

    static getSelectionOutcome()
    {
        return BrowserLlmCapability.#selectionOutcome;
    }

    /**
     * The catalogue key this device resolved to, or null when none fits.
     */
    static getSelectedModelKey()
    {
        return BrowserLlmCapability.#selectionOutcome ? BrowserLlmCapability.#selectionOutcome.getModelKey() : null;
    }

    /**
     * The merged manifest descriptor for the selected model, or null.
     */
    static getSelectedDescriptor()
    {
        const modelKey = BrowserLlmCapability.getSelectedModelKey();
        return modelKey ? BrowserLlmManifestClient.getDescriptor(modelKey) : null;
    }

    /**
     * Real byte count for the selected model when the server reported one,
     * falling back to the catalogue's estimate. Drives the download bar.
     */
    static getEstimatedTotalBytes()
    {
        const descriptor = BrowserLlmCapability.getSelectedDescriptor();
        return descriptor && Number.isFinite(descriptor.totalBytes) ? descriptor.totalBytes : 0;
    }

    static getEstimatedTotalLabel()
    {
        const descriptor = BrowserLlmCapability.getSelectedDescriptor();
        return descriptor ? descriptor.approximateTotalLabel : "";
    }

    /**
     * Short label for the selected model, e.g. "1.5B" or "0.5B", so the tier
     * picker can name what this device actually got.
     */
    static getSelectedParameterLabel()
    {
        const descriptor = BrowserLlmCapability.getSelectedDescriptor();
        return descriptor ? descriptor.parameterLabel : "";
    }

    static isSelectedModelProcessorBacked()
    {
        const descriptor = BrowserLlmCapability.getSelectedDescriptor();
        return Boolean(descriptor && descriptor.executionBackend === "WASM");
    }

    /**
     * Update the cached state, persist it (best-effort), and broadcast a
     * CAPABILITY_CHANGED event so the picker and activity surfaces re-render.
     */
    static async setState(newState, extra = {})
    {
        BrowserLlmCapability.#state = newState;

        if (typeof extra.fraction === "number")
        {
            BrowserLlmCapability.#progressFraction = extra.fraction;
        }
        if (extra.error !== undefined)
        {
            BrowserLlmCapability.#lastError = extra.error;
        }

        await BrowserLlmCapability.#writePersistedState(
        {
            state: newState,
            modelKey: BrowserLlmCapability.getSelectedModelKey(),
            fraction: BrowserLlmCapability.#progressFraction,
            errorMessage: BrowserLlmCapability.#lastError ? String(BrowserLlmCapability.#lastError) : null,
            lastTransitionAt: Date.now(),
        });

        window.dispatchEvent(new CustomEvent(BrowserLlmDownloadEvents.CAPABILITY_CHANGED,
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
        BrowserLlmCapability.#progressFraction = fraction;
    }

    static async setDeclined(bDeclined)
    {
        await Persistence.write(
            BrowserLlmDownloadConstants.LOCAL_DECLINED_PERSISTENCE_KEY,
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
        switch (BrowserLlmCapability.#state)
        {
            case browserLlmDownloadStates.UNSUPPORTED:
                return BrowserLlmCapability.#buildUnavailableReasonText();

            case browserLlmDownloadStates.NOT_STARTED:
            {
                const sizeLabel = BrowserLlmCapability.getEstimatedTotalLabel();
                const modelLabel = BrowserLlmCapability.getSelectedParameterLabel();
                const sizeClause = sizeLabel ? ` (${modelLabel}, ${sizeLabel})` : "";
                return `Free needs its AI model on this device${sizeClause}. Click to start the download.`;
            }

            case browserLlmDownloadStates.DOWNLOADING:
            {
                const percent = Math.round(Math.max(0, Math.min(1, BrowserLlmCapability.#progressFraction)) * 100);
                return `Downloading the on-device AI model… ${percent}%. Please wait.`;
            }

            case browserLlmDownloadStates.DECLINED:
                return "Download was declined. Click to download it now.";

            case browserLlmDownloadStates.FAILED:
            {
                const detail = BrowserLlmCapability.#lastError ? ` (${BrowserLlmCapability.#lastError})` : "";
                return `Download failed${detail}. Click to retry.`;
            }

            case browserLlmDownloadStates.READY:
                return null;

            default: return "Free tier is unavailable right now.";
        }
    }

    static #buildUnavailableReasonText()
    {
        const unavailableReason = BrowserLlmCapability.#selectionOutcome
            ? BrowserLlmCapability.#selectionOutcome.getUnavailableReason()
            : browserLlmUnavailableReasons.NO_MODEL_PROVISIONED;

        switch (unavailableReason)
        {
            case browserLlmUnavailableReasons.HANDHELD_DEVICE:
                return "Free runs its AI model on the device, which needs a desktop or laptop with graphics acceleration. On a phone or tablet, pick Basic, Pro or Pro Plus.";

            case browserLlmUnavailableReasons.NO_SUPPORTED_BACKEND:
                return "This device can't run an AI model locally — it has no graphics acceleration (WebGPU). Try a recent Chrome or Edge on a machine with a working graphics card, or pick Basic, Pro or Pro Plus.";

            case browserLlmUnavailableReasons.GPU_LIMITS_TOO_LOW:
                return "This device's graphics hardware is below what the smallest available model needs. Pick Basic, Pro or Pro Plus instead.";

            case browserLlmUnavailableReasons.DEVICE_MEMORY_TOO_LOW:
                return "This device doesn't report enough memory to run an AI model locally. Pick Basic, Pro or Pro Plus instead.";

            case browserLlmUnavailableReasons.NO_MODEL_PROVISIONED:
                return "No on-device AI model is installed on this server yet, so the Free tier can't run. Pick Basic, Pro or Pro Plus for now.";

            case browserLlmUnavailableReasons.MANIFEST_UNREACHABLE:
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
        return BrowserLlmCapability.#selectionOutcome
            ? BrowserLlmCapability.#selectionOutcome.getHonestNote()
            : null;
    }

    /**
     * True when clicking the disabled Free row should trigger a download or
     * retry — i.e. the learner can recover by their own action. False for
     * UNSUPPORTED (nothing to recover) and DOWNLOADING (already running).
     */
    static isRecoverableByUser()
    {
        return BrowserLlmCapability.#state === browserLlmDownloadStates.NOT_STARTED
            || BrowserLlmCapability.#state === browserLlmDownloadStates.DECLINED
            || BrowserLlmCapability.#state === browserLlmDownloadStates.FAILED;
    }

    static async #readPersistedState()
    {
        try
        {
            const exists = await Persistence.exists(BrowserLlmDownloadConstants.LOCAL_STATE_PERSISTENCE_KEY);
            if (!exists)
            {
                return null;
            }
            return await Persistence.read(BrowserLlmDownloadConstants.LOCAL_STATE_PERSISTENCE_KEY, dataFormats.JSON);
        }
        catch (readError)
        {
            console.warn(`[BrowserLlmCapability] Could not read persisted state: ${readError?.message || readError}`);
            return null;
        }
    }

    static async #readDeclinedFlag()
    {
        try
        {
            const exists = await Persistence.exists(BrowserLlmDownloadConstants.LOCAL_DECLINED_PERSISTENCE_KEY);
            if (!exists)
            {
                return false;
            }
            const record = await Persistence.read(BrowserLlmDownloadConstants.LOCAL_DECLINED_PERSISTENCE_KEY, dataFormats.JSON);
            return record?.declined === true;
        }
        catch (readError)
        {
            console.warn(`[BrowserLlmCapability] Could not read declined flag: ${readError?.message || readError}`);
            return false;
        }
    }

    static async #writePersistedState(record)
    {
        try
        {
            await Persistence.write(BrowserLlmDownloadConstants.LOCAL_STATE_PERSISTENCE_KEY, record, dataFormats.JSON);
        }
        catch (writeError)
        {
            console.warn(`[BrowserLlmCapability] Could not persist state: ${writeError?.message || writeError}`);
        }
    }
}

export default BrowserLlmCapability;
