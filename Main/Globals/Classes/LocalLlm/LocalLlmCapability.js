import { localLlmDownloadStates } from "../../Enumerations/LocalLlmDownloadStates.js";
import { localLlmUnavailableReasons } from "../../Enumerations/LocalLlmUnavailableReasons.js";
import LocalLlmDownloadConstants from "../../Constants/LocalLlmDownloadConstants.js";
import LocalLlmDownloadEvents from "../../Events/LocalLlmDownloadEvents.js";
import LocalLlmDeviceProbe from "./LocalLlmDeviceProbe.js";
import LocalLlmDriverFactory from "./Drivers/LocalLlmDriverFactory.js";
import LocalLlmManifestClient from "./LocalLlmManifestClient.js";
import LocalLlmModelInventory from "./LocalLlmModelInventory.js";
import LocalLlmModelSelector from "./LocalLlmModelSelector.js";
import LocalLlmSessionController from "./LocalLlmSessionController.js";
import Persistence from "../Persistence.js";
import PreferredLocalLlmModel from "./PreferredLocalLlmModel.js";
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
            await LocalLlmModelInventory.hydrate();

            const bUserDeclined = await LocalLlmCapability.#readDeclinedFlag();

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
                // device's store — running without a network is the entire
                // premise of this tier. Only a reachable server saying "no
                // model fits this device" is grounds for UNSUPPORTED.
                const bManifestUnreachable = LocalLlmManifestClient.didLastFetchFail();
                const bHoldsAnyModel = LocalLlmModelInventory.listDownloadedModelKeys().length > 0;

                if (bManifestUnreachable && bHoldsAnyModel)
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

            const selectedModelKey = selectionOutcome.getModelKey();
            LocalLlmCapability.#persistedStateAtBoot = LocalLlmModelInventory.getRecord(selectedModelKey);

            if (bUserDeclined)
            {
                LocalLlmCapability.#state = localLlmDownloadStates.DECLINED;
            }
            else
            {
                // Read straight off the inventory for THIS model. There is
                // deliberately no reconciliation against what other models are
                // doing any more: the old single record forced exactly that,
                // and demoting a model to NOT_STARTED because a DIFFERENT one
                // was mid-download is what made switching to an already-held
                // model announce that the tier needed a download while the
                // cached weights answered questions perfectly well.
                LocalLlmCapability.#state = LocalLlmModelInventory.getState(selectedModelKey);
                LocalLlmCapability.#progressFraction = LocalLlmModelInventory.getProgressFraction(selectedModelKey);
                LocalLlmCapability.#lastError = LocalLlmModelInventory.getErrorMessage(selectedModelKey);
            }

            LocalLlmCapability.#bInitialized = true;
            console.log(`[LocalLlmCapability] ${LocalLlmCapability.getDiagnosticText()}`);
        })();

        return LocalLlmCapability.#initializePromise;
    }

    /**
     * Corrects the inventory against what the device's store actually holds,
     * for one model.
     *
     * The inventory records what the app believes it downloaded. The store can
     * disagree without telling anyone — a browser evicting an origin's cache
     * under storage pressure, a learner clearing site data, an operating
     * system reclaiming an app's data directory. Believing the record over the
     * store is what produces the worst version of this feature: a tier that
     * reports itself ready and then fails to load, every time, with no way for
     * the learner to find out why.
     *
     * A driver answering `null` means it cannot tell, and the recorded belief
     * is left exactly as it was. That case is common and benign — an app shell
     * older than this frontend does not know the question — and treating it as
     * absence would offer a multi-gigabyte re-download to every learner who
     * had not yet updated the app.
     *
     * Returns true when the record was changed.
     */
    static async reconcileModelAgainstStorage(modelKey)
    {
        const descriptor = LocalLlmManifestClient.getDescriptor(modelKey);
        if (!descriptor)
        {
            return false;
        }

        const driver = LocalLlmDriverFactory.resolveForDescriptor(descriptor);
        if (driver === null)
        {
            return false;
        }

        let bPresent = null;
        try
        {
            bPresent = await driver.hasModel(descriptor);
        }
        catch (presenceError)
        {
            console.warn(`[LocalLlmCapability] Could not verify "${modelKey}" against storage: ${presenceError?.message || presenceError}`);
            return false;
        }

        if (bPresent === null)
        {
            return false;
        }

        const recordedState = LocalLlmModelInventory.getState(modelKey);

        if (bPresent && recordedState !== localLlmDownloadStates.READY)
        {
            // The weights are there and the record did not know. The common
            // cause is a download that completed into the store while the
            // session that started it was closed before it could write READY.
            console.log(`[LocalLlmCapability] "${modelKey}" is present on this device — recording it as ready.`);
            await LocalLlmModelInventory.setState(modelKey, localLlmDownloadStates.READY,
            {
                fraction: 1,
                totalBytes: Number.isFinite(descriptor.totalBytes) ? descriptor.totalBytes : 0,
                errorMessage: null,
            });
            return true;
        }

        if (!bPresent && recordedState === localLlmDownloadStates.READY)
        {
            console.log(`[LocalLlmCapability] "${modelKey}" is recorded as ready but is not on this device — clearing the record.`);
            await LocalLlmModelInventory.setState(modelKey, localLlmDownloadStates.NOT_STARTED,
            {
                fraction: 0,
                errorMessage: null,
            });
            return true;
        }

        return false;
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
            ? LocalLlmCapability.#nameForState(persistedRecord.state)
            : "no record on disk";
        const heldModelKeys = LocalLlmModelInventory.listDownloadedModelKeys();

        // Whether the record escaped the per-identity prefix. Reported rather
        // than assumed: the fix is one entry in a Set built at class-init
        // time, and if that entry ever resolves to undefined it fails
        // silently — the record goes back to being per-user and the repeat
        // download returns with nothing to show for it.
        const bRecordIsDeviceScoped = UserIdentityConstants.GLOBAL_KEYS.has(
            LocalLlmDownloadConstants.LOCAL_MODEL_INVENTORY_PERSISTENCE_KEY
        );

        // Which models this device holds, not merely which one is selected.
        // The single most common support question is "why is it downloading
        // again" and the answer is usually that the device holds a different
        // model from the one now chosen — invisible when only the selection is
        // reported.
        //
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
            + ` · held=[${heldModelKeys.join(", ") || "none"}]`
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

    /**
     * Removes one model's weights from this device, and moves the tier onto
     * something that still works.
     *
     * THE SWITCH IS THE POINT, not a courtesy. Deleting the model in use would
     * otherwise leave the Free tier selected and pointing at weights that are
     * gone: the next question either fails or silently re-downloads a
     * gigabyte, and neither is what "delete" meant. So the preference moves
     * first — to another model this device already holds if there is one,
     * because switching to something present is instant and switching to
     * something absent is another download.
     *
     * The order is deliberate throughout: unload before delete (a loaded model
     * holds its weights open, and on Windows an open mapping makes the file
     * undeletable), delete before forgetting (a forgotten record with the
     * bytes still on disk is space the learner cannot see or ever reclaim),
     * and re-resolve last, once the facts it reads are settled.
     */
    static async deleteModel(modelKey)
    {
        const descriptor = LocalLlmManifestClient.getDescriptor(modelKey);
        if (!descriptor)
        {
            throw new Error(`This device has no record of a model called "${modelKey}".`);
        }

        const driver = LocalLlmDriverFactory.resolveForDescriptor(descriptor);
        if (driver === null)
        {
            throw new Error(`Nothing in this build can manage "${modelKey}" (${descriptor.executionBackend}).`);
        }

        if (LocalLlmSessionController.getActiveDescriptor()?.modelKey === modelKey)
        {
            LocalLlmSessionController.release();
        }

        await driver.deleteModel(descriptor);
        await LocalLlmModelInventory.forget(modelKey);

        await PreferredLocalLlmModel.hydrate();
        if (PreferredLocalLlmModel.getModelKey() === modelKey)
        {
            const eligibleModels = await LocalLlmCapability.listEligibleModels();

            await PreferredLocalLlmModel.setModelKey(LocalLlmCapability.chooseReplacementModelKey(
                eligibleModels,
                modelKey,
                LocalLlmModelInventory.listDownloadedModelKeys()
            ));
        }

        await LocalLlmCapability.reresolve();
    }

    /**
     * What to select once `removedModelKey` is gone.
     *
     * Prefers a model already on the device, taking `eligibleModels` in the
     * order the selector ranked them, so the tier keeps working immediately
     * rather than after another download. Falls back to null — "automatic" —
     * which is the right answer when nothing else is held: with no present
     * model to prefer, naming a specific one would be a guess the learner
     * never made, and it would silently commit them to fetching it.
     *
     * Pure, and public for that reason. It is the entire decision behind
     * "deleting the model in use must leave the tier working", and proving it
     * needs neither a device nor a gigabyte of weights.
     */
    static chooseReplacementModelKey(eligibleModels, removedModelKey, downloadedModelKeys)
    {
        const downloadedKeySet = new Set(Array.isArray(downloadedModelKeys) ? downloadedModelKeys : []);

        for (const candidate of (Array.isArray(eligibleModels) ? eligibleModels : []))
        {
            if (candidate.modelKey !== removedModelKey && downloadedKeySet.has(candidate.modelKey))
            {
                return candidate.modelKey;
            }
        }

        return null;
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
     * Records a state transition for one model and broadcasts it.
     *
     * `extra.modelKey` names the model the transition is ABOUT, defaulting to
     * the one currently selected. The download manager always passes it
     * explicitly, and must: it captures the model at the moment the download
     * starts, and the learner is free to select a different one while those
     * bytes are still arriving. Without that, a switch mid-download would file
     * the finished download's READY against whichever model happened to be
     * selected when it landed — recording the wrong model as present and
     * leaving the real one looking as though it had never been fetched.
     *
     * The tier-facing cached state is updated only when the transition
     * concerns the SELECTED model, so a background download of something else
     * cannot make the picker announce that the tier is busy.
     */
    static async setState(newState, extra = {})
    {
        const selectedModelKey = LocalLlmCapability.getSelectedModelKey();
        const affectedModelKey = typeof extra.modelKey === "string" && extra.modelKey.length > 0
            ? extra.modelKey
            : selectedModelKey;

        if (affectedModelKey)
        {
            await LocalLlmModelInventory.setState(affectedModelKey, newState,
            {
                fraction: typeof extra.fraction === "number" ? extra.fraction : undefined,
                totalBytes: typeof extra.totalBytes === "number" ? extra.totalBytes : undefined,
                errorMessage: extra.error !== undefined ? (extra.error ? String(extra.error) : null) : undefined,
            });
        }

        if (affectedModelKey !== selectedModelKey)
        {
            return;
        }

        LocalLlmCapability.#state = newState;

        if (typeof extra.fraction === "number")
        {
            LocalLlmCapability.#progressFraction = extra.fraction;
        }
        if (extra.error !== undefined)
        {
            LocalLlmCapability.#lastError = extra.error;
        }

        window.dispatchEvent(new CustomEvent(LocalLlmDownloadEvents.CAPABILITY_CHANGED,
        {
            detail: { state: newState }
        }));
    }

    /**
     * Update progress without changing state. Cheaper than setState because
     * nothing is persisted on every tick — the fraction is flushed on the next
     * state change.
     */
    static updateProgress(fraction, modelKey = null)
    {
        const affectedModelKey = modelKey || LocalLlmCapability.getSelectedModelKey();

        if (affectedModelKey)
        {
            LocalLlmModelInventory.updateProgress(affectedModelKey, fraction);
        }

        if (affectedModelKey === LocalLlmCapability.getSelectedModelKey())
        {
            LocalLlmCapability.#progressFraction = fraction;
        }
    }

    /**
     * What this device holds for one model, regardless of what is selected.
     * The model table renders a row per catalogue entry from this.
     */
    static getModelState(modelKey)
    {
        return LocalLlmModelInventory.getState(modelKey);
    }

    static getModelProgressFraction(modelKey)
    {
        return LocalLlmModelInventory.getProgressFraction(modelKey);
    }

    static isModelDownloaded(modelKey)
    {
        return LocalLlmModelInventory.isDownloaded(modelKey);
    }

    static getDownloadingModelKey()
    {
        return LocalLlmModelInventory.getDownloadingModelKey();
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

}

export default LocalLlmCapability;
