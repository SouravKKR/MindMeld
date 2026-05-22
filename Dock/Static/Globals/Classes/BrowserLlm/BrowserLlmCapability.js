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
 *   1. navigator.gpu — without WebGPU we can never run the model, so the
 *      state is pinned to UNSUPPORTED regardless of any other signal.
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
    static #state = browserLlmDownloadStates.NOT_STARTED;
    static #progressFraction = 0;
    static #bInitialized = false;
    static #initializePromise = null;
    static #lastError = null;

    /**
     * Resolves the persisted state + declined flag against the device's
     * WebGPU support and seeds the in-memory cache. Safe to await more
     * than once — repeated calls share the same in-flight promise.
     */
    static initialize()
    {
        if (BrowserLlmCapability.#initializePromise)
        {
            return BrowserLlmCapability.#initializePromise;
        }

        BrowserLlmCapability.#initializePromise = (async () =>
        {
            if (!BrowserLlmCapability.#hasWebGpu())
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
                return "This device doesn't support WebGPU. Switch to a device with WebGPU support to use the Free tier.";

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

    static #hasWebGpu()
    {
        return typeof navigator !== "undefined" && !!navigator.gpu;
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
