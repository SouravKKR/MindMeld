import LocalLlmDownloadConstants from "../../Constants/LocalLlmDownloadConstants.js";
import { localLlmWorkerCommands } from "../../Enumerations/LocalLlmWorkerCommands.js";
import { localLlmWorkerEvents } from "../../Enumerations/LocalLlmWorkerEvents.js";


/**
 * LocalLlmEngineClient
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
 *     LocalLlmDownloadConstants so it stays in step with where the build
 *     actually places the file.
 *
 *   - The main-thread fallback imports its module through a specifier built
 *     at call time. A string literal inside import() would make the bundler
 *     follow it and inline the 6.8 MB vendor bundle into the SPA; computing
 *     it leaves a genuine run-time fetch.
 */
class LocalLlmEngineClient
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
        if (LocalLlmEngineClient.#shouldUseMainThread())
        {
            const runner = await LocalLlmEngineClient.#getMainThreadRunner();
            await runner.load(descriptor, onProgress);
            return;
        }

        await LocalLlmEngineClient.#sendCommand(
            localLlmWorkerCommands.LOAD,
            { descriptor: descriptor },
            {
                onProgressEvent: localLlmWorkerEvents.LOAD_PROGRESS,
                onProgress: onProgress,
                completionEvent: localLlmWorkerEvents.LOAD_COMPLETE,
            }
        );
    }

    /**
     * Streams a completion, calling `onToken` with each fragment. Resolves to
     * the full text.
     */
    static async generate(request, onToken)
    {
        if (LocalLlmEngineClient.#shouldUseMainThread())
        {
            const runner = await LocalLlmEngineClient.#getMainThreadRunner();
            return await runner.generate(request, onToken);
        }

        const completionPayload = await LocalLlmEngineClient.#sendCommand(
            localLlmWorkerCommands.GENERATE,
            { request: request },
            {
                onProgressEvent: localLlmWorkerEvents.TOKEN,
                onProgress: (payload) => onToken(payload.value),
                completionEvent: localLlmWorkerEvents.GENERATION_COMPLETE,
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
        if (LocalLlmEngineClient.#mainThreadRunner)
        {
            LocalLlmEngineClient.#mainThreadRunner.interrupt();
            return;
        }
        if (LocalLlmEngineClient.#worker)
        {
            LocalLlmEngineClient.#worker.postMessage({ command: localLlmWorkerCommands.INTERRUPT, requestId: 0 });
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
        for (const pendingRequest of LocalLlmEngineClient.#pendingRequests.values())
        {
            const abortError = new Error("The on-device model was stopped.");
            abortError.name = "AbortError";
            pendingRequest.reject(abortError);
        }
        LocalLlmEngineClient.#pendingRequests.clear();

        if (LocalLlmEngineClient.#worker)
        {
            LocalLlmEngineClient.#worker.terminate();
            LocalLlmEngineClient.#worker = null;
        }
        if (LocalLlmEngineClient.#mainThreadRunner)
        {
            LocalLlmEngineClient.#mainThreadRunner.unload();
            LocalLlmEngineClient.#mainThreadRunner = null;
        }
    }

    static isEngineReady()
    {
        return LocalLlmEngineClient.#worker !== null || LocalLlmEngineClient.#mainThreadRunner !== null;
    }

    /**
     * Whether the browser's store already holds this model's weights.
     * Resolves null when the question cannot be answered — see
     * LocalLlmDriver.hasModel for why that is not the same as false.
     */
    static async hasModel(descriptor)
    {
        if (LocalLlmEngineClient.#shouldUseMainThread())
        {
            const runner = await LocalLlmEngineClient.#getMainThreadRunner();
            return await runner.hasModel(descriptor);
        }

        const presencePayload = await LocalLlmEngineClient.#sendCommand(
            localLlmWorkerCommands.HAS_MODEL,
            { descriptor: descriptor },
            { completionEvent: localLlmWorkerEvents.MODEL_PRESENCE }
        );

        return presencePayload && typeof presencePayload.bPresent === "boolean" ? presencePayload.bPresent : null;
    }

    /**
     * Removes this model's weights from the browser's store.
     *
     * The worker is terminated first. It holds the engine, and on the graphics
     * backend that engine keeps the weights open — deleting underneath a live
     * engine leaves the two disagreeing about what exists, and the next load
     * reads a cache that is half gone. Terminating costs a reload the learner
     * has already accepted by asking for a deletion.
     */
    static async deleteModel(descriptor)
    {
        if (LocalLlmEngineClient.#shouldUseMainThread())
        {
            const runner = await LocalLlmEngineClient.#getMainThreadRunner();
            await runner.deleteModel(descriptor);
            return;
        }

        await LocalLlmEngineClient.#sendCommand(
            localLlmWorkerCommands.DELETE_MODEL,
            { descriptor: descriptor },
            { completionEvent: localLlmWorkerEvents.MODEL_DELETED }
        );

        LocalLlmEngineClient.terminate();
    }

    static #shouldUseMainThread()
    {
        return LocalLlmEngineClient.#bWorkerUnavailable || typeof Worker === "undefined";
    }

    static #getWorker()
    {
        if (LocalLlmEngineClient.#worker)
        {
            return LocalLlmEngineClient.#worker;
        }

        const worker = new Worker(LocalLlmDownloadConstants.WORKER_SCRIPT_PATH, { type: "module" });
        worker.onmessage = (messageEvent) =>
        {
            LocalLlmEngineClient.#handleWorkerMessage(messageEvent.data);
        };
        worker.onerror = (errorEvent) =>
        {
            const workerError = new Error(errorEvent?.message || "The on-device model worker stopped unexpectedly.");
            for (const pendingRequest of LocalLlmEngineClient.#pendingRequests.values())
            {
                pendingRequest.reject(workerError);
            }
            LocalLlmEngineClient.#pendingRequests.clear();
        };

        LocalLlmEngineClient.#worker = worker;
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
        if (LocalLlmEngineClient.#mainThreadRunner)
        {
            return LocalLlmEngineClient.#mainThreadRunner;
        }

        const runnerModuleSpecifier = new URL(
            LocalLlmDownloadConstants.ENGINE_RUNNER_MODULE_PATH,
            window.location.origin
        ).href;
        const runnerModule = await import(/* webpackIgnore: true */ runnerModuleSpecifier);
        const EngineRunner = runnerModule.default;

        LocalLlmEngineClient.#mainThreadRunner = new EngineRunner();
        return LocalLlmEngineClient.#mainThreadRunner;
    }

    static #sendCommand(command, commandPayload, { onProgressEvent, onProgress, completionEvent })
    {
        return new Promise((resolve, reject) =>
        {
            let worker;
            try
            {
                worker = LocalLlmEngineClient.#getWorker();
            }
            catch (workerConstructionError)
            {
                // Fall back for the rest of the session rather than retrying
                // a constructor that will keep throwing.
                console.warn(`[LocalLlmEngineClient] Module workers unavailable, running on the main thread: ${workerConstructionError?.message || workerConstructionError}`);
                LocalLlmEngineClient.#bWorkerUnavailable = true;
                reject(workerConstructionError);
                return;
            }

            const requestId = LocalLlmEngineClient.#nextRequestId;
            LocalLlmEngineClient.#nextRequestId++;

            LocalLlmEngineClient.#pendingRequests.set(requestId,
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

        const pendingRequest = LocalLlmEngineClient.#pendingRequests.get(message.requestId);
        if (!pendingRequest)
        {
            return;
        }

        if (message.event === localLlmWorkerEvents.FAILED)
        {
            LocalLlmEngineClient.#pendingRequests.delete(message.requestId);
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
            LocalLlmEngineClient.#pendingRequests.delete(message.requestId);
            pendingRequest.resolve(message.payload || {});
        }
    }
}

export default LocalLlmEngineClient;
