import LocalLlmDriver from "./LocalLlmDriver.js";
import NativeBridge from "../../NativeBridge.js";
import NativeLlmProtocolConstants from "../../../Constants/NativeLlmProtocolConstants.js";


/**
 * NativeRuntimeDriver
 *
 * Runs the model in the installed app's own process, as compiled native code,
 * and streams the result back over the shell's command channel.
 *
 * This is the path that exists because the web platform has no third option.
 * Graphics acceleration in a browser is fast where it works and simply absent
 * on most phones; the processor fallback is universal and, single-threaded,
 * measured 0.1 tokens per second — slow enough to be worse than nothing.
 * Compiled code on the same phone has neither problem, which is the whole
 * reason for the driver layer.
 *
 * It contains no shell API calls of its own: everything goes through
 * NativeBridge, so the shell stays replaceable. It also contains no inference
 * logic — that lives behind an interface on the native side, so the library
 * doing the work is swappable without touching this file.
 *
 * EVERY EXCHANGE IS CORRELATED BY REQUEST ID. Native events are broadcast to
 * the whole window, so a token event carries no inherent notion of which
 * generation produced it. Filtering on an id is what stops two concurrent
 * answers — a card's Ask AI and a deck chat, say — from interleaving into each
 * other's output, a corruption that cannot be untangled afterwards because the
 * fragments arrive as plain text.
 */
class NativeRuntimeDriver extends LocalLlmDriver
{
    #bModelLoaded = false;
    #loadedModelKey = null;
    #nextRequestId = 1;
    #activeGenerationRequestId = null;

    #takeRequestId()
    {
        const requestId = this.#nextRequestId;
        this.#nextRequestId++;
        return requestId;
    }

    async probeCapability()
    {
        if (!NativeBridge.isAvailable())
        {
            return null;
        }

        try
        {
            const capability = await NativeBridge.invoke(NativeLlmProtocolConstants.COMMAND_PROBE_CAPABILITY);

            return {
                bAvailable: true,
                systemMemoryMegabytes: Number.isFinite(capability?.totalMemoryMegabytes) ? capability.totalMemoryMegabytes : null,
                logicalCoreCount: Number.isFinite(capability?.logicalCoreCount) ? capability.logicalCoreCount : null,
                bMobileDevice: capability?.bMobileDevice === true,
                accelerationLabel: typeof capability?.accelerationLabel === "string" ? capability.accelerationLabel : "",
            };
        }
        catch (probeError)
        {
            // An installed app updates on its own schedule, so a shell older
            // than this frontend will not know the command and rejects here.
            // That is a normal state, not a fault: reporting the path as
            // unavailable sends the selector to the browser driver, which is
            // exactly what that build can still do.
            console.warn(`[NativeRuntimeDriver] The native runtime did not answer a capability probe, treating it as unavailable: ${probeError?.message || probeError}`);
            return null;
        }
    }

    /**
     * Fetches the weights if the device does not hold them, then loads them.
     *
     * The two are separate commands rather than one because they fail
     * differently and are reported differently: a download is minutes long,
     * resumable and byte-denominated, while a load is seconds long and either
     * works or does not. Merging them would flatten a slow, recoverable
     * network step into an opaque "loading" state.
     */
    async load(descriptor, onProgress)
    {
        const requestId = this.#takeRequestId();
        const reportProgress = (progressPayload, statusText) =>
        {
            if (typeof onProgress !== "function" || progressPayload?.requestId !== requestId)
            {
                return;
            }

            const totalBytes = Number.isFinite(progressPayload.totalBytes) ? progressPayload.totalBytes : 0;
            const loadedBytes = Number.isFinite(progressPayload.loadedBytes) ? progressPayload.loadedBytes : 0;

            onProgress({
                fraction: totalBytes > 0 ? Math.max(0, Math.min(1, loadedBytes / totalBytes)) : 0,
                loadedBytes: loadedBytes,
                totalBytes: totalBytes,
                statusText: statusText,
            });
        };

        const stopDownloadListener = await NativeBridge.listen(
            NativeLlmProtocolConstants.EVENT_DOWNLOAD_PROGRESS,
            (nativeEvent) => reportProgress(nativeEvent?.payload, "Downloading the on-device model")
        );
        const stopLoadListener = await NativeBridge.listen(
            NativeLlmProtocolConstants.EVENT_LOAD_PROGRESS,
            (nativeEvent) => reportProgress(nativeEvent?.payload, "Loading the on-device model")
        );

        try
        {
            await NativeBridge.invoke(NativeLlmProtocolConstants.COMMAND_ENSURE_MODEL_PRESENT,
            {
                requestId: requestId,
                modelKey: descriptor.modelKey,
                weightsUrl: descriptor.weightsUrl,
                weightsFileName: descriptor.weightsFileName,
                expectedSha256: descriptor.sha256 || null,
                expectedTotalBytes: Number.isFinite(descriptor.totalBytes) ? descriptor.totalBytes : 0,
            });

            await NativeBridge.invoke(NativeLlmProtocolConstants.COMMAND_LOAD_MODEL,
            {
                requestId: requestId,
                modelKey: descriptor.modelKey,
                weightsFileName: descriptor.weightsFileName,
                contextWindowTokens: descriptor.contextWindowTokens,
                threadCount: descriptor.recommendedThreadCount || 0,
            });

            this.#bModelLoaded = true;
            this.#loadedModelKey = descriptor.modelKey;
        }
        finally
        {
            stopDownloadListener();
            stopLoadListener();
        }
    }

    async generate(request, onToken)
    {
        const requestId = this.#takeRequestId();
        this.#activeGenerationRequestId = requestId;

        let assembledText = "";

        // Subscribed BEFORE the command is invoked. The native side may emit
        // its first token before the invoke promise has even settled, and a
        // listener attached afterwards would miss the opening of the answer —
        // which reads as a truncated first sentence rather than as a bug.
        const stopTokenListener = await NativeBridge.listen(
            NativeLlmProtocolConstants.EVENT_TOKEN,
            (nativeEvent) =>
            {
                const payload = nativeEvent?.payload;
                if (payload?.requestId !== requestId || typeof payload.value !== "string")
                {
                    return;
                }

                assembledText += payload.value;
                if (typeof onToken === "function")
                {
                    onToken(payload.value);
                }
            }
        );

        try
        {
            const completion = await NativeBridge.invoke(NativeLlmProtocolConstants.COMMAND_GENERATE_COMPLETION,
            {
                requestId: requestId,
                systemPrompt: request.systemPrompt,
                userPrompt: request.userPrompt,
                maximumNewTokens: request.maximumNewTokens,
                temperature: request.temperature,
            });

            // The command's own return value wins when it has one: it is the
            // engine's authoritative transcript. The locally assembled text is
            // the fallback for a shell that streams without returning.
            return typeof completion === "string" && completion.length > 0 ? completion : assembledText;
        }
        finally
        {
            stopTokenListener();
            this.#activeGenerationRequestId = null;
        }
    }

    interrupt()
    {
        if (this.#activeGenerationRequestId === null)
        {
            return;
        }

        // Fire-and-forget by contract, so a failure to deliver the stop must
        // not reject into the caller — it is already tearing down.
        NativeBridge.invoke(NativeLlmProtocolConstants.COMMAND_INTERRUPT_GENERATION,
        {
            requestId: this.#activeGenerationRequestId,
        })
        .catch((interruptError) =>
        {
            console.warn(`[NativeRuntimeDriver] Could not deliver the interrupt: ${interruptError?.message || interruptError}`);
        });
    }

    unload()
    {
        this.#bModelLoaded = false;
        this.#loadedModelKey = null;

        NativeBridge.invoke(NativeLlmProtocolConstants.COMMAND_UNLOAD_MODEL)
            .catch((unloadError) =>
            {
                console.warn(`[NativeRuntimeDriver] Could not unload the native model: ${unloadError?.message || unloadError}`);
            });
    }

    isReady()
    {
        return this.#bModelLoaded;
    }

    getLoadedModelKey()
    {
        return this.#loadedModelKey;
    }
}

export default NativeRuntimeDriver;
