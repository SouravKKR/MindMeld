import BrowserLlmEngineRunner from "./BrowserLlmEngineRunner.js";
import BrowserLlmWorkerProtocol from "./BrowserLlmWorkerProtocol.js";

/**
 * BrowserLlmWorker
 *
 * The dedicated worker the Free tier's engine runs inside. It is a thin
 * dispatcher: decode a command, hand it to BrowserLlmEngineRunner, post the
 * results back tagged with the request id the caller correlates on.
 *
 * A worker rather than the main thread is not a nicety. The processor backend
 * runs a multi-billion-parameter model through single-threaded WebAssembly,
 * and on the main thread a single answer would freeze the entire app —
 * scrolling, the study timer, the dialog's own close button — for minutes.
 * Even the graphics backend blocks the thread during tokenisation and
 * sampling. Off-thread, a slow answer is merely slow.
 *
 * It lives under ThirdParty/ because the bundler skips this directory: a
 * worker anywhere else would be deleted by the post-bundle source sweep, and
 * its import of the vendor bundle would drag 6.8 MB into the SPA bundle.
 */
class BrowserLlmWorkerHost
{
    #engineRunner = new BrowserLlmEngineRunner();

    start()
    {
        self.onmessage = (messageEvent) =>
        {
            this.#handleMessage(messageEvent.data).catch((handlerError) =>
            {
                // Nothing above this catch can report — the host is the only
                // thing listening, so a failure must always come back as an
                // event or the caller waits forever.
                // The name travels alongside the message because it is the only
                // thing distinguishing "the GPU died, stop using it" from an
                // ordinary failure — and an Error's name does not survive being
                // rebuilt from a message on the far side of postMessage.
                this.#post(messageEvent?.data?.requestId, BrowserLlmWorkerProtocol.FAILED,
                {
                    message: handlerError?.message || String(handlerError),
                    name: handlerError?.name || ""
                });
            });
        };
    }

    async #handleMessage(message)
    {
        if (!message || typeof message.command !== "number")
        {
            return;
        }

        const requestId = message.requestId;

        if (message.command === BrowserLlmWorkerProtocol.LOAD)
        {
            await this.#engineRunner.load(message.descriptor, (progressReport) =>
            {
                this.#post(requestId, BrowserLlmWorkerProtocol.LOAD_PROGRESS, progressReport);
            });
            this.#post(requestId, BrowserLlmWorkerProtocol.LOAD_COMPLETE, { modelKey: this.#engineRunner.getLoadedModelKey() });
            return;
        }

        if (message.command === BrowserLlmWorkerProtocol.GENERATE)
        {
            const completeText = await this.#engineRunner.generate(message.request, (deltaText) =>
            {
                this.#post(requestId, BrowserLlmWorkerProtocol.TOKEN, { value: deltaText });
            });
            this.#post(requestId, BrowserLlmWorkerProtocol.GENERATION_COMPLETE, { value: completeText });
            return;
        }

        if (message.command === BrowserLlmWorkerProtocol.INTERRUPT)
        {
            this.#engineRunner.interrupt();
            return;
        }

        if (message.command === BrowserLlmWorkerProtocol.UNLOAD)
        {
            await this.#engineRunner.unload();
            this.#post(requestId, BrowserLlmWorkerProtocol.GENERATION_COMPLETE, { value: "" });
            return;
        }

        if (message.command === BrowserLlmWorkerProtocol.HAS_MODEL)
        {
            const bPresent = await this.#engineRunner.hasModel(message.descriptor);
            this.#post(requestId, BrowserLlmWorkerProtocol.MODEL_PRESENCE, { bPresent: bPresent });
            return;
        }

        if (message.command === BrowserLlmWorkerProtocol.DELETE_MODEL)
        {
            await this.#engineRunner.deleteModel(message.descriptor);
            this.#post(requestId, BrowserLlmWorkerProtocol.MODEL_DELETED, { modelKey: message.descriptor?.modelKey || "" });
        }
    }

    #post(requestId, workerEvent, payload)
    {
        self.postMessage({ requestId: requestId, event: workerEvent, payload: payload });
    }
}

new BrowserLlmWorkerHost().start();
