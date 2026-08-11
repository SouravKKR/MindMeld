import { localLlmDownloadStates } from "../../Enumerations/LocalLlmDownloadStates.js";
import LocalLlmDownloadEvents from "../../Events/LocalLlmDownloadEvents.js";
import LocalLlmCapability from "./LocalLlmCapability.js";
import LocalLlmSessionController from "./LocalLlmSessionController.js";


/**
 * LocalLlmDownloadManager
 *
 * Owns the lifecycle of the Free-tier on-device model download.
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
 * "Download" is really "load the engine": both engines fetch their own weights
 * into the browser's Cache API as part of initialisation and report progress
 * while they do it, so there is no separate fetch to drive. Reaching READY
 * therefore proves rather more than that the bytes arrived — it proves the
 * model actually initialised on this hardware, which is the thing that
 * matters and the thing a plain download could never establish.
 *
 * The download is always started by the learner. It is hundreds of megabytes,
 * frequently over a mobile connection, so nothing here runs on its own.
 */
class LocalLlmDownloadManager
{
    static #bRunning = false;
    static #abortController = null;
    static #downloadStartedAt = null;

    /**
     * Begin (or restart) the model download. No-op if already running.
     * Transitions DECLINED/FAILED/NOT_STARTED → DOWNLOADING and drives the
     * engine load.
     */
    static async start()
    {
        if (LocalLlmDownloadManager.#bRunning)
        {
            console.warn("[LocalLlmDownloadManager] start() called while a download is already running — ignoring.");
            return;
        }

        await LocalLlmCapability.initialize();

        if (LocalLlmCapability.getState() === localLlmDownloadStates.UNSUPPORTED)
        {
            console.warn("[LocalLlmDownloadManager] start() called on an UNSUPPORTED device — refusing.");
            return;
        }

        // Clear any prior DECLINED record so the next reload doesn't
        // re-pin the state regardless of how this run ends.
        await LocalLlmCapability.setDeclined(false);

        LocalLlmDownloadManager.#bRunning = true;
        LocalLlmDownloadManager.#abortController = new AbortController();
        LocalLlmDownloadManager.#downloadStartedAt = Date.now();

        await LocalLlmCapability.setState(localLlmDownloadStates.DOWNLOADING, { fraction: 0, error: null });

        window.dispatchEvent(new CustomEvent(LocalLlmDownloadEvents.STARTED,
        {
            detail: { totalBytes: LocalLlmCapability.getEstimatedTotalBytes() }
        }));

        try
        {
            await LocalLlmDownloadManager.#runDownload(LocalLlmDownloadManager.#abortController.signal);

            await LocalLlmCapability.setState(localLlmDownloadStates.READY, { fraction: 1, error: null });
            window.dispatchEvent(new CustomEvent(LocalLlmDownloadEvents.COMPLETED));
        }
        catch (downloadError)
        {
            if (downloadError?.name === "AbortError")
            {
                await LocalLlmCapability.setState(localLlmDownloadStates.NOT_STARTED, { fraction: 0, error: null });
                console.log("[LocalLlmDownloadManager] Download cancelled by user.");
                return;
            }

            const errorMessage = downloadError?.message ? downloadError.message : String(downloadError);
            await LocalLlmCapability.setState(localLlmDownloadStates.FAILED, { error: errorMessage });
            window.dispatchEvent(new CustomEvent(LocalLlmDownloadEvents.FAILED,
            {
                detail: { error: downloadError }
            }));
        }
        finally
        {
            LocalLlmDownloadManager.#bRunning = false;
            LocalLlmDownloadManager.#abortController = null;
        }
    }

    /**
     * Cancel an in-flight download. The state machine falls back to
     * NOT_STARTED so the user can retry on demand.
     *
     * Neither engine offers a cancel, so this destroys the worker outright.
     * Shard fetches already issued still complete into the browser cache,
     * which is harmless — the next attempt reuses them and starts further
     * along than it otherwise would.
     */
    static cancel()
    {
        if (!LocalLlmDownloadManager.#bRunning)
        {
            return;
        }
        LocalLlmDownloadManager.#abortController?.abort();
        LocalLlmSessionController.release();
    }

    /**
     * Record the user's "no thanks" choice. Persisted per-device so the
     * login bootstrap doesn't re-prompt. Recoverable via retry().
     */
    static async decline()
    {
        await LocalLlmCapability.initialize();

        if (LocalLlmCapability.getState() === localLlmDownloadStates.UNSUPPORTED)
        {
            return;
        }

        await LocalLlmCapability.setDeclined(true);
        await LocalLlmCapability.setState(localLlmDownloadStates.DECLINED);
        window.dispatchEvent(new CustomEvent(LocalLlmDownloadEvents.DECLINED));
    }

    /**
     * Clear the declined / failed pin and re-attempt the download. The
     * tier dropdown's "click to retry" path lands here.
     */
    static async retry()
    {
        await LocalLlmCapability.initialize();

        if (LocalLlmCapability.getState() === localLlmDownloadStates.UNSUPPORTED)
        {
            return;
        }

        await LocalLlmCapability.setDeclined(false);
        await LocalLlmCapability.setState(localLlmDownloadStates.NOT_STARTED, { fraction: 0, error: null });
        window.dispatchEvent(new CustomEvent(LocalLlmDownloadEvents.RESUMED));

        await LocalLlmDownloadManager.start();
    }

    static isRunning()
    {
        return LocalLlmDownloadManager.#bRunning;
    }

    static getDownloadStartedAt()
    {
        return LocalLlmDownloadManager.#downloadStartedAt;
    }

    static #fireProgress(processedBytes, totalBytes, statusText)
    {
        const fraction = totalBytes > 0 ? Math.max(0, Math.min(1, processedBytes / totalBytes)) : 0;
        LocalLlmCapability.updateProgress(fraction);
        window.dispatchEvent(new CustomEvent(LocalLlmDownloadEvents.PROGRESS,
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
     * Drives the engine load, forwarding its progress to the activity feed
     * and the tier picker. Resolving means the model is initialised and ready
     * to answer, not merely that its bytes arrived.
     *
     * The abort signal is checked between progress reports rather than passed
     * down: no engine accepts one, so the cancellation path is
     * LocalLlmSessionController.release() in cancel(), and this only needs
     * to stop reporting progress for a load nobody is waiting on any more.
     */
    static async #runDownload(abortSignal)
    {
        const throwIfAborted = () =>
        {
            if (abortSignal.aborted)
            {
                const abortError = new Error("Aborted");
                abortError.name = "AbortError";
                throw abortError;
            }
        };

        throwIfAborted();

        await LocalLlmSessionController.ensureReady((progressReport) =>
        {
            if (abortSignal.aborted)
            {
                return;
            }
            LocalLlmDownloadManager.#fireProgress(
                progressReport.loadedBytes,
                progressReport.totalBytes,
                progressReport.statusText
            );
        });

        throwIfAborted();
    }
}

export default LocalLlmDownloadManager;
