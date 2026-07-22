import { browserLlmDownloadStates } from "../../Enumerations/BrowserLlmDownloadStates.js";
import BrowserLlmDownloadConstants from "../../Constants/BrowserLlmDownloadConstants.js";
import BrowserLlmDownloadEvents from "../../Events/BrowserLlmDownloadEvents.js";
import BrowserLlmCapability from "./BrowserLlmCapability.js";


/**
 * BrowserLlmDownloadManager
 *
 * Owns the lifecycle of the Free-tier in-browser LLM weights download.
 * State machine:
 *
 *     NOT_STARTED ──start()──▶ DOWNLOADING ──success──▶ READY
 *           ▲                       │
 *           │                       └──failure──▶ FAILED
 *           │                       │
 *           │                       └──cancel()──▶ NOT_STARTED
 *           │
 *     DECLINED ─decline()/retry()─▶ NOT_STARTED (via retry)
 *
 * The actual `WebLLM.CreateMLCEngine` invocation that drives the fetch
 * + Cache-API population is intentionally STUBBED in `#runDownload()`.
 * Everything else — capability + persistence + events + activity
 * surface integration — is wired and ready. When the user is ready to
 * connect the real WebLLM engine, replace the TODO block in
 * `#runDownload()` with the CreateMLCEngine call from the reference
 * implementation at [F:/Testing/CogniumLearn/webllm.html].
 */
class BrowserLlmDownloadManager
{
    static #bRunning = false;
    static #abortController = null;
    static #downloadStartedAt = null;

    /**
     * Begin (or restart) the model download. No-op if already running.
     * Transitions DECLINED/FAILED/NOT_STARTED → DOWNLOADING and runs
     * the (currently stubbed) fetch loop.
     */
    static async start()
    {
        if (BrowserLlmDownloadManager.#bRunning)
        {
            console.warn("[BrowserLlmDownloadManager] start() called while a download is already running — ignoring.");
            return;
        }

        await BrowserLlmCapability.initialize();

        if (BrowserLlmCapability.getState() === browserLlmDownloadStates.UNSUPPORTED)
        {
            console.warn("[BrowserLlmDownloadManager] start() called on an UNSUPPORTED device — refusing.");
            return;
        }

        // Clear any prior DECLINED record so the next reload doesn't
        // re-pin the state regardless of how this run ends.
        await BrowserLlmCapability.setDeclined(false);

        BrowserLlmDownloadManager.#bRunning = true;
        BrowserLlmDownloadManager.#abortController = new AbortController();
        BrowserLlmDownloadManager.#downloadStartedAt = Date.now();

        await BrowserLlmCapability.setState(browserLlmDownloadStates.DOWNLOADING, { fraction: 0, error: null });

        window.dispatchEvent(new CustomEvent(BrowserLlmDownloadEvents.STARTED,
        {
            detail: { totalBytes: BrowserLlmDownloadConstants.ESTIMATED_TOTAL_BYTES }
        }));

        try
        {
            await BrowserLlmDownloadManager.#runDownload(BrowserLlmDownloadManager.#abortController.signal);

            // STUB only: until the real fetch is wired up, completion
            // means "the stub flow has returned cleanly". The real
            // CreateMLCEngine call will yield this naturally.
            await BrowserLlmCapability.setState(browserLlmDownloadStates.READY, { fraction: 1, error: null });
            window.dispatchEvent(new CustomEvent(BrowserLlmDownloadEvents.COMPLETED));
        }
        catch (downloadError)
        {
            if (downloadError?.name === "AbortError")
            {
                await BrowserLlmCapability.setState(browserLlmDownloadStates.NOT_STARTED, { fraction: 0, error: null });
                console.log("[BrowserLlmDownloadManager] Download cancelled by user.");
                return;
            }

            const errorMessage = downloadError?.message ? downloadError.message : String(downloadError);
            await BrowserLlmCapability.setState(browserLlmDownloadStates.FAILED, { error: errorMessage });
            window.dispatchEvent(new CustomEvent(BrowserLlmDownloadEvents.FAILED,
            {
                detail: { error: downloadError }
            }));
        }
        finally
        {
            BrowserLlmDownloadManager.#bRunning = false;
            BrowserLlmDownloadManager.#abortController = null;
        }
    }

    /**
     * Cancel an in-flight download. The state machine falls back to
     * NOT_STARTED so the user can retry on demand.
     */
    static cancel()
    {
        if (!BrowserLlmDownloadManager.#bRunning)
        {
            return;
        }
        BrowserLlmDownloadManager.#abortController?.abort();
    }

    /**
     * Record the user's "no thanks" choice. Persisted per-device so the
     * login bootstrap doesn't re-prompt. Recoverable via retry().
     */
    static async decline()
    {
        await BrowserLlmCapability.initialize();

        if (BrowserLlmCapability.getState() === browserLlmDownloadStates.UNSUPPORTED)
        {
            return;
        }

        await BrowserLlmCapability.setDeclined(true);
        await BrowserLlmCapability.setState(browserLlmDownloadStates.DECLINED);
        window.dispatchEvent(new CustomEvent(BrowserLlmDownloadEvents.DECLINED));
    }

    /**
     * Clear the declined / failed pin and re-attempt the download. The
     * tier dropdown's "click to retry" path lands here.
     */
    static async retry()
    {
        await BrowserLlmCapability.initialize();

        if (BrowserLlmCapability.getState() === browserLlmDownloadStates.UNSUPPORTED)
        {
            return;
        }

        await BrowserLlmCapability.setDeclined(false);
        await BrowserLlmCapability.setState(browserLlmDownloadStates.NOT_STARTED, { fraction: 0, error: null });
        window.dispatchEvent(new CustomEvent(BrowserLlmDownloadEvents.RESUMED));

        await BrowserLlmDownloadManager.start();
    }

    static isRunning()
    {
        return BrowserLlmDownloadManager.#bRunning;
    }

    static getDownloadStartedAt()
    {
        return BrowserLlmDownloadManager.#downloadStartedAt;
    }

    static #fireProgress(processedBytes, totalBytes, statusText)
    {
        const fraction = totalBytes > 0 ? Math.max(0, Math.min(1, processedBytes / totalBytes)) : 0;
        BrowserLlmCapability.updateProgress(fraction);
        window.dispatchEvent(new CustomEvent(BrowserLlmDownloadEvents.PROGRESS,
        {
            detail:
            {
                processedBytes,
                totalBytes,
                fraction,
                statusText: statusText || ""
            }
        }));
    }

    /**
     * STUB. Replace this body when wiring the real WebLLM engine.
     *
     * Expected behaviour once wired:
     *   1. GET BrowserLlmDownloadConstants.MANIFEST_ENDPOINT_PATH to
     *      discover the model's shard list + total byte count.
     *   2. Instantiate the WebLLM engine via CreateMLCEngine with an
     *      appConfig whose `model_list[0].model` points at
     *      `${ASSETS_BASE_PATH}/${MODEL_ID}/` and whose `model_lib`
     *      points at the .wasm file under the same prefix.
     *   3. Wire WebLLM's initProgressCallback to call #fireProgress so
     *      the UI gets per-shard progress updates.
     *   4. On completion the engine instance can be cached for reuse
     *      by the Free-tier query path (out of scope this round).
     *
     * Until then, this function just sleeps a short while so the UI
     * lifecycle (started → progress → completed) is exercisable end-to-
     * end. Aborts mid-sleep when cancel() fires.
     */
    static async #runDownload(abortSignal)
    {
        const totalBytes = BrowserLlmDownloadConstants.ESTIMATED_TOTAL_BYTES;
        const fakeStepCount = 20;
        const fakeStepDelayMs = 250;

        for (let stepIndex = 1; stepIndex <= fakeStepCount; stepIndex++)
        {
            if (abortSignal.aborted)
            {
                const abortError = new Error("Aborted");
                abortError.name = "AbortError";
                throw abortError;
            }

            await new Promise((resolve, reject) =>
            {
                const timeoutId = setTimeout(resolve, fakeStepDelayMs);
                abortSignal.addEventListener("abort", () =>
                {
                    clearTimeout(timeoutId);
                    const abortError = new Error("Aborted");
                    abortError.name = "AbortError";
                    reject(abortError);
                }, { once: true });
            });

            const processedBytes = Math.floor((stepIndex / fakeStepCount) * totalBytes);
            BrowserLlmDownloadManager.#fireProgress(processedBytes, totalBytes, `Shard ${stepIndex}/${fakeStepCount}`);
        }

        // TODO: replace the loop above with the real WebLLM
        // CreateMLCEngine call. See the reference at
        // F:/Testing/CogniumLearn/webllm.html for the exact appConfig shape.
    }
}

export default BrowserLlmDownloadManager;
