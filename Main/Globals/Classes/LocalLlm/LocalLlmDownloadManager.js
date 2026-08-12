import { localLlmDownloadStates } from "../../Enumerations/LocalLlmDownloadStates.js";
import LocalLlmDownloadEvents from "../../Events/LocalLlmDownloadEvents.js";
import LocalLlmCapability from "./LocalLlmCapability.js";
import LocalLlmManifestClient from "./LocalLlmManifestClient.js";
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
    static #runningModelKey = null;

    /**
     * Begin (or restart) a model download. No-op if one is already running.
     *
     * `modelKey` names the model to fetch, defaulting to the selected one so
     * the tier picker's "click to download" needs no argument. The model table
     * passes one explicitly, which is what lets a learner fetch a model they
     * are not currently using.
     *
     * ONE DOWNLOAD AT A TIME, ACROSS ALL MODELS. They are hundreds of
     * megabytes to two gigabytes each and compete for the same connection;
     * running two halves the speed of both and ends with neither finished.
     */
    static async start(modelKey = null)
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

        // Captured once, here, and used for every state write below. The
        // learner is free to select a different model while these bytes are
        // arriving, and re-reading the selection at completion time would file
        // this download's result against whatever happened to be selected then.
        const targetModelKey = modelKey || LocalLlmCapability.getSelectedModelKey();
        if (!targetModelKey)
        {
            console.warn("[LocalLlmDownloadManager] start() could not determine which model to download — refusing.");
            return;
        }

        // Clear any prior DECLINED record so the next reload doesn't
        // re-pin the state regardless of how this run ends.
        await LocalLlmCapability.setDeclined(false);

        LocalLlmDownloadManager.#bRunning = true;
        LocalLlmDownloadManager.#runningModelKey = targetModelKey;
        LocalLlmDownloadManager.#abortController = new AbortController();
        LocalLlmDownloadManager.#downloadStartedAt = Date.now();

        await LocalLlmCapability.setState(localLlmDownloadStates.DOWNLOADING,
        {
            modelKey: targetModelKey,
            fraction: 0,
            error: null,
        });

        window.dispatchEvent(new CustomEvent(LocalLlmDownloadEvents.STARTED,
        {
            detail: { modelKey: targetModelKey, totalBytes: LocalLlmCapability.getEstimatedTotalBytes() }
        }));

        try
        {
            await LocalLlmDownloadManager.#runDownload(
                targetModelKey,
                LocalLlmDownloadManager.#abortController.signal
            );

            await LocalLlmCapability.setState(localLlmDownloadStates.READY,
            {
                modelKey: targetModelKey,
                fraction: 1,
                error: null,
            });
            window.dispatchEvent(new CustomEvent(LocalLlmDownloadEvents.COMPLETED,
            {
                detail: { modelKey: targetModelKey }
            }));
        }
        catch (downloadError)
        {
            if (downloadError?.name === "AbortError")
            {
                await LocalLlmCapability.setState(localLlmDownloadStates.NOT_STARTED,
                {
                    modelKey: targetModelKey,
                    fraction: 0,
                    error: null,
                });
                console.log("[LocalLlmDownloadManager] Download cancelled by user.");
                return;
            }

            const errorMessage = downloadError?.message ? downloadError.message : String(downloadError);
            await LocalLlmCapability.setState(localLlmDownloadStates.FAILED,
            {
                modelKey: targetModelKey,
                error: errorMessage,
            });
            window.dispatchEvent(new CustomEvent(LocalLlmDownloadEvents.FAILED,
            {
                detail: { modelKey: targetModelKey, error: downloadError }
            }));
        }
        finally
        {
            LocalLlmDownloadManager.#bRunning = false;
            LocalLlmDownloadManager.#runningModelKey = null;
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

    static getRunningModelKey()
    {
        return LocalLlmDownloadManager.#runningModelKey;
    }

    static #fireProgress(modelKey, processedBytes, totalBytes, statusText)
    {
        const fraction = totalBytes > 0 ? Math.max(0, Math.min(1, processedBytes / totalBytes)) : 0;
        LocalLlmCapability.updateProgress(fraction, modelKey);
        window.dispatchEvent(new CustomEvent(LocalLlmDownloadEvents.PROGRESS,
        {
            detail:
            {
                modelKey,
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
    static async #runDownload(targetModelKey, abortSignal)
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

        const reportProgress = (progressReport) =>
        {
            if (abortSignal.aborted)
            {
                return;
            }
            LocalLlmDownloadManager.#fireProgress(
                targetModelKey,
                progressReport.loadedBytes,
                progressReport.totalBytes,
                progressReport.statusText
            );
        };

        throwIfAborted();

        // The selected model goes through ensureReady, so reaching READY keeps
        // proving what it has always proved here: not merely that the bytes
        // arrived, but that the model initialised on this hardware — which a
        // plain fetch can never establish, and which is the thing that decides
        // whether the tier actually works.
        //
        // Any OTHER model is fetched and no more. Loading it would evict the
        // model the learner is using mid-question, to prove something about a
        // model they have not switched to; the proof is deferred to the moment
        // they do switch, which is the first point it matters.
        if (targetModelKey === LocalLlmCapability.getSelectedModelKey())
        {
            await LocalLlmSessionController.ensureReady(reportProgress);
        }
        else
        {
            const descriptor = LocalLlmManifestClient.getDescriptor(targetModelKey);
            if (!descriptor)
            {
                throw new Error(`The server no longer serves "${targetModelKey}".`);
            }
            await LocalLlmSessionController.downloadModel(descriptor, reportProgress);
        }

        throwIfAborted();
    }
}

export default LocalLlmDownloadManager;
