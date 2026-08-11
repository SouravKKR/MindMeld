import BrowserLlmDownloadConstants from "../../Constants/BrowserLlmDownloadConstants.js";
import { browserLlmWorkerCommands } from "../../Enumerations/BrowserLlmWorkerCommands.js";
import { browserLlmWorkerEvents } from "../../Enumerations/BrowserLlmWorkerEvents.js";


/**
 * BrowserLlmEngineClient
 *
 * Owns the single worker the on-device model runs in, and turns its message
 * traffic into promises and callbacks the rest of the app can use.
 *
 * One worker, one loaded model, for the whole tab. The weights occupy well
 * over a gigabyte of GPU or system memory, so a second engine is not a
 * performance question — it is an out-of-memory crash.
 *
 * Two loading details that are easy to get wrong:
 *
 *   - The worker URL is ROOT-relative. A deep link puts the document at a
 *     path like /PaidDeck, where a "./ThirdParty/..." specifier resolves
 *     against the wrong directory and 404s. The path comes from
 *     BrowserLlmDownloadConstants so it stays in step with where the build
 *     actually places the file.
 *
 *   - The main-thread fallback imports its module through a specifier built
 *     at call time. A string literal inside import() would make the bundler
 *     follow it and inline the 6.8 MB vendor bundle into the SPA; computing
 *     it leaves a genuine run-time fetch.
 */
class BrowserLlmEngineClient
{
    static #worker = null;
    static #mainThreadRunner = null;
    static #nextRequestId = 1;
    static #pendingRequests = new Map();
    static #bWorkerUnavailable = false;

    /**
     * Loads a model. `onProgress` receives
     * `{ fraction, loadedBytes, totalBytes, statusText }` throughout.
     */
    static async load(descriptor, onProgress)
    {
        if (BrowserLlmEngineClient.#shouldUseMainThread())
        {
            const runner = await BrowserLlmEngineClient.#getMainThreadRunner();
            await runner.load(descriptor, onProgress);
            return;
        }

        await BrowserLlmEngineClient.#sendCommand(
            browserLlmWorkerCommands.LOAD,
            { descriptor: descriptor },
            {
                onProgressEvent: browserLlmWorkerEvents.LOAD_PROGRESS,
                onProgress: onProgress,
                completionEvent: browserLlmWorkerEvents.LOAD_COMPLETE,
            }
        );
    }

    /**
     * Streams a completion, calling `onToken` with each fragment. Resolves to
     * the full text.
     */
    static async generate(request, onToken)
    {
        if (BrowserLlmEngineClient.#shouldUseMainThread())
        {
            const runner = await BrowserLlmEngineClient.#getMainThreadRunner();
            return await runner.generate(request, onToken);
        }

        const completionPayload = await BrowserLlmEngineClient.#sendCommand(
            browserLlmWorkerCommands.GENERATE,
            { request: request },
            {
                onProgressEvent: browserLlmWorkerEvents.TOKEN,
                onProgress: (payload) => onToken(payload.value),
                completionEvent: browserLlmWorkerEvents.GENERATION_COMPLETE,
            }
        );

        return completionPayload && typeof completionPayload.value === "string" ? completionPayload.value : "";
    }

    /**
     * Asks the engine to stop generating. Fire-and-forget: the in-flight
     * generate() promise resolves normally with whatever was produced, so the
     * caller sees a clean end of stream rather than an error.
     */
    static interrupt()
    {
        if (BrowserLlmEngineClient.#mainThreadRunner)
        {
            BrowserLlmEngineClient.#mainThreadRunner.interrupt();
            return;
        }
        if (BrowserLlmEngineClient.#worker)
        {
            BrowserLlmEngineClient.#worker.postMessage({ command: browserLlmWorkerCommands.INTERRUPT, requestId: 0 });
        }
    }

    /**
     * Tears the engine down entirely, rejecting anything still in flight.
     * The only way to abort a load — neither engine offers a cancel, so the
     * worker is destroyed and any shard fetches already issued simply finish
     * into the browser's cache, where the next attempt reuses them.
     */
    static terminate()
    {
        for (const pendingRequest of BrowserLlmEngineClient.#pendingRequests.values())
        {
            const abortError = new Error("The on-device model was stopped.");
            abortError.name = "AbortError";
            pendingRequest.reject(abortError);
        }
        BrowserLlmEngineClient.#pendingRequests.clear();

        if (BrowserLlmEngineClient.#worker)
        {
            BrowserLlmEngineClient.#worker.terminate();
            BrowserLlmEngineClient.#worker = null;
        }
        if (BrowserLlmEngineClient.#mainThreadRunner)
        {
            BrowserLlmEngineClient.#mainThreadRunner.unload();
            BrowserLlmEngineClient.#mainThreadRunner = null;
        }
    }

    static isEngineReady()
    {
        return BrowserLlmEngineClient.#worker !== null || BrowserLlmEngineClient.#mainThreadRunner !== null;
    }

    static #shouldUseMainThread()
    {
        return BrowserLlmEngineClient.#bWorkerUnavailable || typeof Worker === "undefined";
    }

    static #getWorker()
    {
        if (BrowserLlmEngineClient.#worker)
        {
            return BrowserLlmEngineClient.#worker;
        }

        const worker = new Worker(BrowserLlmDownloadConstants.WORKER_SCRIPT_PATH, { type: "module" });
        worker.onmessage = (messageEvent) =>
        {
            BrowserLlmEngineClient.#handleWorkerMessage(messageEvent.data);
        };
        worker.onerror = (errorEvent) =>
        {
            const workerError = new Error(errorEvent?.message || "The on-device model worker stopped unexpectedly.");
            for (const pendingRequest of BrowserLlmEngineClient.#pendingRequests.values())
            {
                pendingRequest.reject(workerError);
            }
            BrowserLlmEngineClient.#pendingRequests.clear();
        };

        BrowserLlmEngineClient.#worker = worker;
        return worker;
    }

    /**
     * Module workers are unavailable on some older browsers, where the
     * constructor throws. Running on the main thread there is worse — a long
     * generation will visibly stall the page — but it is the difference
     * between a slow feature and no feature.
     */
    static async #getMainThreadRunner()
    {
        if (BrowserLlmEngineClient.#mainThreadRunner)
        {
            return BrowserLlmEngineClient.#mainThreadRunner;
        }

        const runnerModuleSpecifier = new URL(
            BrowserLlmDownloadConstants.ENGINE_RUNNER_MODULE_PATH,
            window.location.origin
        ).href;
        const runnerModule = await import(/* webpackIgnore: true */ runnerModuleSpecifier);
        const EngineRunner = runnerModule.default;

        BrowserLlmEngineClient.#mainThreadRunner = new EngineRunner();
        return BrowserLlmEngineClient.#mainThreadRunner;
    }

    static #sendCommand(command, commandPayload, { onProgressEvent, onProgress, completionEvent })
    {
        return new Promise((resolve, reject) =>
        {
            let worker;
            try
            {
                worker = BrowserLlmEngineClient.#getWorker();
            }
            catch (workerConstructionError)
            {
                // Fall back for the rest of the session rather than retrying
                // a constructor that will keep throwing.
                console.warn(`[BrowserLlmEngineClient] Module workers unavailable, running on the main thread: ${workerConstructionError?.message || workerConstructionError}`);
                BrowserLlmEngineClient.#bWorkerUnavailable = true;
                reject(workerConstructionError);
                return;
            }

            const requestId = BrowserLlmEngineClient.#nextRequestId;
            BrowserLlmEngineClient.#nextRequestId++;

            BrowserLlmEngineClient.#pendingRequests.set(requestId,
            {
                resolve: resolve,
                reject: reject,
                onProgressEvent: onProgressEvent,
                onProgress: onProgress,
                completionEvent: completionEvent,
            });

            worker.postMessage({ command: command, requestId: requestId, ...commandPayload });
        });
    }

    static #handleWorkerMessage(message)
    {
        if (!message || typeof message.event !== "number")
        {
            return;
        }

        const pendingRequest = BrowserLlmEngineClient.#pendingRequests.get(message.requestId);
        if (!pendingRequest)
        {
            return;
        }

        if (message.event === browserLlmWorkerEvents.FAILED)
        {
            BrowserLlmEngineClient.#pendingRequests.delete(message.requestId);
            const failureError = new Error(message.payload?.message || "The on-device model failed.");
            // Carried across the worker boundary by name, because that is what
            // tells the session controller a lost GPU device from a normal
            // failure — the two need opposite responses.
            if (message.payload?.name)
            {
                failureError.name = message.payload.name;
            }
            pendingRequest.reject(failureError);
            return;
        }

        if (message.event === pendingRequest.onProgressEvent)
        {
            if (typeof pendingRequest.onProgress === "function")
            {
                pendingRequest.onProgress(message.payload || {});
            }
            return;
        }

        if (message.event === pendingRequest.completionEvent)
        {
            BrowserLlmEngineClient.#pendingRequests.delete(message.requestId);
            pendingRequest.resolve(message.payload || {});
        }
    }
}

export default BrowserLlmEngineClient;
