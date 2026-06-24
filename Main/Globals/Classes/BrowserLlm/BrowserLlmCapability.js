import { browserLlmDownloadStates } from "../../Enumerations/BrowserLlmDownloadStates.js";
import BrowserLlmDownloadConstants from "../../Constants/BrowserLlmDownloadConstants.js";
import BrowserLlmDownloadEvents from "../../Events/BrowserLlmDownloadEvents.js";
import Persistence from "../Persistence.js";
import { dataFormats } from "../../Enumerations/DataFormats.js";


/**
 * BrowserLlmCapability
 *
 * Single source of truth for whether the in-browser Free-tier model can
 * be used on this device. The state is one of `browserLlmDownloadStates`
 * and is derived from three inputs:
 *
 *   1. Device capability (`#probeCapability`) — not just `navigator.gpu`
 *      presence, but an actual WebGPU adapter whose limits clear the
 *      thresholds WebLLM enforces to load the weights (plus a device-
 *      memory floor when the browser reports it). A device that can't run
 *      the ~2GB model is pinned to UNSUPPORTED regardless of any other
 *      signal, so the download is never offered on hardware that can't
 *      use it.
 *   2. A persisted DECLINED flag (per-device, written by
 *      BrowserLlmDownloadManager.decline()) — surfaces the "user said
 *      no thanks, but here's a retry button" UX.
 *   3. A persisted download-state record (per-device) carrying
 *      { state, processedBytes?, totalBytes?, lastTransitionAt }.
 *
 * Hydration is async (Persistence reads from IDB on web, FS on Tauri)
 * so callers wait on `BrowserLlmCapability.initialize()` once at boot.
 * After that, `getState()` and `getDisabledReasonText()` are sync.
 *
 * Mutations go through `setState(...)` — the manager calls this; we
 * persist + fire CAPABILITY_CHANGED on every transition so the tier
 * dropdown re-renders.
 */
class BrowserLlmCapability
{
    // Minimum WebGPU adapter limits the device must report before we
    // consider it able to load the Free-tier weights. These mirror the
    // exact thresholds WebLLM itself enforces at engine init — a smaller
    // adapter throws "requested maxBufferSize exceeds limit" mid-load, so
    // we refuse the download up front rather than fail after a 2GB fetch.
    static MINIMUM_GPU_BUFFER_SIZE_BYTES = 268435456; // 256 MB
    static MINIMUM_GPU_STORAGE_BINDING_SIZE_BYTES = 1 << 30; // 1 GB

    // Floor for navigator.deviceMemory (gigabytes) when the browser
    // reports it. It's absent on Firefox/Safari and capped at 8 on
    // Chromium, so a missing value is treated as "unknown — don't block".
    static MINIMUM_DEVICE_MEMORY_GIGABYTES = 4;

    static #state = browserLlmDownloadStates.NOT_STARTED;
    static #progressFraction = 0;
    static #bInitialized = false;
    static #initializePromise = null;
    static #lastError = null;

    /**
     * Resolves the persisted state + declined flag against the device's
     * capability (`#probeCapability`) and seeds the in-memory cache. Safe
     * to await more than once — repeated calls share the same in-flight
     * promise.
     */
    static initialize()
    {
        if (BrowserLlmCapability.#initializePromise)
        {
            return BrowserLlmCapability.#initializePromise;
        }

        BrowserLlmCapability.#initializePromise = (async () =>
        {
            if (!(await BrowserLlmCapability.#probeCapability()))
            {
                BrowserLlmCapability.#state = browserLlmDownloadStates.UNSUPPORTED;
                BrowserLlmCapability.#bInitialized = true;
                return;
            }

            const persistedState = await BrowserLlmCapability.#readPersistedState();
            const bUserDeclined = await BrowserLlmCapability.#readDeclinedFlag();

            // A persisted DECLINED flag wins over a stale state record —
            // the user's choice trumps an interrupted download whose
            // last on-disk state was DOWNLOADING.
            if (bUserDeclined)
            {
                BrowserLlmCapability.#state = browserLlmDownloadStates.DECLINED;
            }
            else if (persistedState && typeof persistedState.state === "number")
            {
                // A DOWNLOADING record on disk means the previous session
                // was killed mid-fetch. We don't know how much survived
                // in Cache API; demote to NOT_STARTED so the user
                // explicitly retriggers. (Resumption can be wired later.)
                if (persistedState.state === browserLlmDownloadStates.DOWNLOADING)
                {
                    BrowserLlmCapability.#state = browserLlmDownloadStates.NOT_STARTED;
                }
                else
                {
                    BrowserLlmCapability.#state = persistedState.state;
                }
                BrowserLlmCapability.#progressFraction = typeof persistedState.fraction === "number"
                    ? persistedState.fraction
                    : 0;
            }
            else
            {
                BrowserLlmCapability.#state = browserLlmDownloadStates.NOT_STARTED;
            }

            BrowserLlmCapability.#bInitialized = true;
        })();

        return BrowserLlmCapability.#initializePromise;
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

    /**
     * Update the cached state, persist it (best-effort), and broadcast
     * a CAPABILITY_CHANGED event so the dropdown / activity surfaces
     * re-render. `extra` carries optional fields the manager wants to
     * round-trip across reloads (progress fraction, last error message).
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
            state:    newState,
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
     * Update progress without changing state. Cheaper than setState
     * because we don't need to re-persist on every tick — the persisted
     * fraction will be flushed on the next state change.
     */
    static updateProgress(fraction)
    {
        BrowserLlmCapability.#progressFraction = fraction;
        // No persistence write here — progress is ephemeral; on reload
        // we restart from NOT_STARTED (the DOWNLOADING demotion above).
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
     * One-line human-readable reason the Free tier is unavailable, used
     * by the tier dropdown's hover bubble. Returns null when state is
     * READY (chip is fully enabled).
     */
    static getDisabledReasonText()
    {
        switch (BrowserLlmCapability.#state)
        {
            case browserLlmDownloadStates.UNSUPPORTED:
                return "This device can't run the offline AI model (it needs WebGPU and enough GPU memory). Switch to a more capable device to use the Free tier.";

            case browserLlmDownloadStates.NOT_STARTED:
                return `Free needs the offline AI model (${BrowserLlmDownloadConstants.ESTIMATED_TOTAL_LABEL}). Click to start the background download.`;

            case browserLlmDownloadStates.DOWNLOADING:
            {
                const percent = Math.round(Math.max(0, Math.min(1, BrowserLlmCapability.#progressFraction)) * 100);
                return `Downloading offline AI model… ${percent}%. Please wait.`;
            }

            case browserLlmDownloadStates.DECLINED:
                return "Download was declined. Click to attempt the download now.";

            case browserLlmDownloadStates.FAILED:
            {
                const detail = BrowserLlmCapability.#lastError ? ` (${BrowserLlmCapability.#lastError})` : "";
                return `Download failed${detail}. Click to retry.`;
            }

            case browserLlmDownloadStates.READY:
                return null;

            default:
                return "Free tier is unavailable right now.";
        }
    }

    /**
     * Returns true when clicking the disabled Free row should trigger
     * a download attempt / retry — i.e. the user can recover from the
     * current state by their own action. False for UNSUPPORTED (no
     * recovery possible) and DOWNLOADING (already in progress).
     */
    static isRecoverableByUser()
    {
        return BrowserLlmCapability.#state === browserLlmDownloadStates.NOT_STARTED
            || BrowserLlmCapability.#state === browserLlmDownloadStates.DECLINED
            || BrowserLlmCapability.#state === browserLlmDownloadStates.FAILED;
    }

    /**
     * Returns true only when this device can realistically run the
     * offline model. Beyond mere `navigator.gpu` presence, we request a
     * real adapter and check its limits against the thresholds WebLLM
     * enforces (so a present-but-too-weak GPU is rejected up front), then
     * apply a device-memory floor when the browser reports one. Any
     * thrown / rejected adapter request is treated as incapable.
     */
    static async #probeCapability()
    {
        if (typeof navigator === "undefined" || !navigator.gpu)
        {
            return false;
        }

        if (typeof navigator.deviceMemory === "number"
            && navigator.deviceMemory > 0
            && navigator.deviceMemory < BrowserLlmCapability.MINIMUM_DEVICE_MEMORY_GIGABYTES)
        {
            return false;
        }

        try
        {
            const adapter = await navigator.gpu.requestAdapter();
            if (!adapter)
            {
                return false;
            }

            const limits = adapter.limits || {};
            if (typeof limits.maxBufferSize !== "number"
                || limits.maxBufferSize < BrowserLlmCapability.MINIMUM_GPU_BUFFER_SIZE_BYTES)
            {
                return false;
            }
            if (typeof limits.maxStorageBufferBindingSize !== "number"
                || limits.maxStorageBufferBindingSize < BrowserLlmCapability.MINIMUM_GPU_STORAGE_BINDING_SIZE_BYTES)
            {
                return false;
            }

            return true;
        }
        catch (probeError)
        {
            console.warn(`[BrowserLlmCapability] WebGPU capability probe failed: ${probeError?.message || probeError}`);
            return false;
        }
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
