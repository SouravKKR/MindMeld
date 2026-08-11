import { WebLLM, Transformers } from "./BrowserLlm.js";

/**
 * BrowserLlmEngineRunner
 *
 * Drives whichever inference engine a model descriptor names, and is the ONLY
 * file allowed to import the vendored BrowserLlm.js bundle. The bundler skips
 * this directory entirely, so the 6.8 MB vendor payload stays a separate,
 * lazily-fetched file instead of being folded into the SPA bundle and run
 * through the obfuscator.
 *
 * It contains no model names, no sizes and no quantisations. Everything it
 * needs — the engine id, where the weights are served from, the ONNX data
 * type, the context window — arrives in the descriptor the caller passes,
 * which originates in Common/Constants/BrowserLlmModelCatalogue.json. Adding
 * a model never touches this file.
 *
 * SELF-HOSTED, ALWAYS. WebLLM's own `prebuiltAppConfig` is deliberately never
 * used: every entry in it points at huggingface.co and raw.githubusercontent
 * .com, and this tier's whole premise is that a learner's card content never
 * leaves their device and the app never calls a third party at run time. The
 * appConfig below is built from the manifest the app's own server returned,
 * and the processor backend is pinned with `allowRemoteModels = false` so a
 * missing local file fails loudly instead of silently reaching a CDN.
 */
class BrowserLlmEngineRunner
{
    // Threads require SharedArrayBuffer, which requires cross-origin
    // isolation (COOP + COEP). Turning that on site-wide would break AdSense,
    // the payment checkout widget and Google sign-in, so the processor
    // backend runs single-threaded. It is slower; it also actually works.
    static ONNX_RUNTIME_THREAD_COUNT = 1;

    static GENERATION_TEMPERATURE = 0.7;
    static GENERATION_TOP_P = 0.9;

    // Where WebLLM stores downloaded weights. Its default backend is the Cache
    // API, whose Cache.add() is missing or unusable on some mobile browsers:
    // the download dies with "'add' was not found on Cache", nothing is ever
    // persisted, and every page load starts the multi-gigabyte fetch again.
    // The IndexedDB backend ships in the same vendor bundle
    // (ArtifactIndexedDBCache) and has no such gap; IndexedDB is already a hard
    // requirement of the app (see Persistence), so this narrows rather than
    // widens what a device must support.
    //
    // The name and the placement both matter. The engine resolves its backend
    // as `appConfig.cacheBackend ?? "cache"` — so this MUST sit inside
    // appConfig, not alongside initProgressCallback in the engine config, and
    // it must be `cacheBackend`. Anything else is silently ignored and the
    // Cache API is used regardless. The accepted values are "cache",
    // "indexeddb" and "cross-origin"; an unrecognised one logs "Unsupported
    // cacheType" and falls back to "cache".
    //
    // Changing this value orphans weights cached under the previous backend —
    // they are re-downloaded once.
    static WEB_LLM_CACHE_BACKEND = "indexeddb";

    // WebLLM's own wording when its engine object is alive but holds no model.
    // Matched, not compared: the message continues with API advice, and the
    // engine has phrased it both as "before trying to complete
    // ChatCompletionRequest" and "before calling chatCompletion()".
    static MODEL_NOT_LOADED_ERROR_PATTERN = /model not loaded|reload\(model\)/i;

    // The GPU took the device down mid-flight. Distinct from the pattern above
    // because the response has to be different: rebuilding the same graphics
    // model on hardware that just hung will hang again. Chrome/Dawn surfaces
    // this as DXGI_ERROR_DEVICE_HUNG with "Device was lost", and every WebLLM
    // object built on that device then answers "Object has already been
    // disposed" — which is the message the learner actually sees.
    static DEVICE_LOST_ERROR_PATTERN = /device was lost|device lost|already been disposed|DEVICE_HUNG|DEVICE_REMOVED|GPUDeviceLostInfo/i;

    // Set on errors matching the pattern above so callers can tell "retry this"
    // from "stop using the graphics backend on this machine".
    static DEVICE_LOST_ERROR_NAME = "BrowserLlmDeviceLostError";

    #engine = null;
    #generationPipeline = null;
    #stoppingCriteria = null;
    #loadedModelKey = null;
    #executionBackend = null;
    // The descriptor the current engine was built from, kept so a lost engine
    // can be rebuilt without going back out to the manifest.
    #loadedDescriptor = null;

    getLoadedModelKey()
    {
        return this.#loadedModelKey;
    }

    isLoaded()
    {
        return this.#engine !== null || this.#generationPipeline !== null;
    }

    /**
     * Loads the model the descriptor names. Resolves once the engine can
     * generate; `onProgress` is called throughout with
     * `{ fraction, loadedBytes, totalBytes, statusText }`, where the byte
     * figures are 0 when the engine only reports a fraction.
     */
    async load(descriptor, onProgress)
    {
        if (this.#loadedModelKey === descriptor.modelKey && this.isLoaded())
        {
            return;
        }

        await this.unload();

        if (descriptor.executionBackend === "WASM")
        {
            await this.#loadTransformersPipeline(descriptor, onProgress);
        }
        else
        {
            // A load can lose the device just as a generation can — a machine
            // whose GPU hangs often does it while the weights are being
            // uploaded. Marked the same way so the one caller that knows what
            // to do about it can act, rather than reporting a bare failure.
            try
            {
                await this.#loadWebLlmEngine(descriptor, onProgress);
            }
            catch (loadError)
            {
                const loadErrorMessage = loadError?.message || String(loadError);
                if (BrowserLlmEngineRunner.DEVICE_LOST_ERROR_PATTERN.test(loadErrorMessage))
                {
                    loadError.name = BrowserLlmEngineRunner.DEVICE_LOST_ERROR_NAME;
                }
                throw loadError;
            }
        }

        this.#loadedModelKey = descriptor.modelKey;
        this.#executionBackend = descriptor.executionBackend;
        this.#loadedDescriptor = descriptor;
    }

    /**
     * Turns a root-relative served path into an absolute URL.
     *
     * Both engines parse these with `new URL(value)`, which throws on a
     * relative path — WebLLM fails with a bare "Failed to construct 'URL'"
     * from deep inside its cache layer, which says nothing about the cause.
     * The manifest deliberately reports root-relative paths, because the
     * server has no business asserting its own public origin, so the
     * conversion happens here, where the engine's requirement is known.
     *
     * `self.location` rather than `window.location`: this runs inside a
     * worker, where there is no window. Same origin either way.
     */
    static toAbsoluteUrl(servedPath)
    {
        if (typeof servedPath !== "string" || servedPath.length === 0)
        {
            return servedPath;
        }
        if (/^https?:\/\//i.test(servedPath))
        {
            return servedPath;
        }
        return new URL(servedPath, self.location.origin).href;
    }

    async #loadWebLlmEngine(descriptor, onProgress)
    {
        const applicationConfiguration =
        {
            cacheBackend: BrowserLlmEngineRunner.WEB_LLM_CACHE_BACKEND,
            model_list: [
                {
                    model: BrowserLlmEngineRunner.toAbsoluteUrl(descriptor.baseUrl),
                    model_id: descriptor.engineModelId,
                    model_lib: BrowserLlmEngineRunner.toAbsoluteUrl(descriptor.modelLibraryUrl),
                    vram_required_MB: descriptor.vramRequiredMegabytes,
                    low_resource_required: true,
                    overrides: { context_window_size: descriptor.contextWindowTokens },
                }
            ]
        };

        this.#engine = await WebLLM.CreateMLCEngine(descriptor.engineModelId,
        {
            appConfig: applicationConfiguration,
            initProgressCallback: (progressReport) =>
            {
                // WebLLM reports a 0..1 fraction and a human string; it never
                // reports bytes. The caller multiplies the fraction by the
                // manifest's real total to drive a byte-denominated bar.
                onProgress(
                {
                    fraction: typeof progressReport?.progress === "number" ? progressReport.progress : 0,
                    loadedBytes: 0,
                    totalBytes: 0,
                    statusText: typeof progressReport?.text === "string" ? progressReport.text : "",
                });
            }
        });
    }

    async #loadTransformersPipeline(descriptor, onProgress)
    {
        Transformers.env.allowRemoteModels = false;
        Transformers.env.allowLocalModels = true;
        // Absolute for the same reason as the graphics path, and additionally
        // because a worker resolves a relative path against its own script
        // location rather than the document's.
        Transformers.env.localModelPath = BrowserLlmEngineRunner.toAbsoluteUrl(descriptor.localModelPath);
        Transformers.env.backends.onnx.wasm.wasmPaths = BrowserLlmEngineRunner.toAbsoluteUrl(descriptor.runtimeBaseUrl);
        Transformers.env.backends.onnx.wasm.numThreads = BrowserLlmEngineRunner.ONNX_RUNTIME_THREAD_COUNT;
        // Already inside a worker — the proxy worker would be a second hop.
        Transformers.env.backends.onnx.wasm.proxy = false;

        // Unlike WebLLM, this backend reports real per-file byte counts, so
        // the totals are accumulated across files as they stream in.
        const bytesLoadedByFile = new Map();
        const bytesTotalByFile = new Map();

        this.#generationPipeline = await Transformers.pipeline("text-generation", descriptor.engineModelId,
        {
            device: "wasm",
            dtype: descriptor.onnxDataType,
            progress_callback: (progressReport) =>
            {
                if (!progressReport || typeof progressReport.file !== "string")
                {
                    return;
                }
                if (typeof progressReport.loaded === "number")
                {
                    bytesLoadedByFile.set(progressReport.file, progressReport.loaded);
                }
                if (typeof progressReport.total === "number" && progressReport.total > 0)
                {
                    bytesTotalByFile.set(progressReport.file, progressReport.total);
                }

                let loadedBytes = 0;
                for (const fileLoadedBytes of bytesLoadedByFile.values())
                {
                    loadedBytes += fileLoadedBytes;
                }
                let knownTotalBytes = 0;
                for (const fileTotalBytes of bytesTotalByFile.values())
                {
                    knownTotalBytes += fileTotalBytes;
                }

                // The denominator has to cover the SAME files as the numerator.
                // A response without Content-Length reports `loaded` but never
                // `total`, and the weights file is exactly the one served that
                // way — so summing loaded across every file while summing total
                // across only the few that answered put a ~1.8 GB numerator
                // over a ~7 MB denominator. The ratio passed 1 on the first
                // chunk, clamped, and the bar read a motionless 100% for the
                // entire download, which is indistinguishable from a hang.
                //
                // When any file's total is unknown, fall back to the
                // catalogue's figure for the whole model, which is what the
                // picker already quotes to the learner.
                const bEveryTotalKnown = bytesTotalByFile.size === bytesLoadedByFile.size;
                const totalBytes = bEveryTotalKnown && knownTotalBytes > 0
                    ? knownTotalBytes
                    : (descriptor.totalBytes || descriptor.approximateTotalBytes || 0);

                onProgress(
                {
                    fraction: totalBytes > 0 ? Math.max(0, Math.min(1, loadedBytes / totalBytes)) : 0,
                    loadedBytes: loadedBytes,
                    totalBytes: totalBytes,
                    statusText: progressReport.file,
                });
            }
        });
    }

    /**
     * Streams a completion. `onToken` receives each new fragment as it is
     * produced; the whole text is also returned.
     */
    async generate({ systemPrompt, userPrompt, maximumNewTokens }, onToken)
    {
        if (!this.isLoaded())
        {
            throw new Error("The on-device model is not loaded.");
        }

        return this.#executionBackend === "WASM"
            ? await this.#generateWithTransformers(systemPrompt, userPrompt, maximumNewTokens, onToken)
            : await this.#generateWithWebLlm(systemPrompt, userPrompt, maximumNewTokens, onToken);
    }

    /**
     * A non-null `#engine` is not proof that a model is loaded. The engine
     * object survives things its GPU device does not: Android reclaims WebGPU
     * resources from a backgrounded tab, and on a phone sitting exactly at the
     * 128 MB maxStorageBufferBindingSize floor (mlc-ai/web-llm#209) memory
     * pressure can take the device out from under a loaded model. Our
     * `isLoaded()` still answers yes, so the request goes through and WebLLM
     * refuses it from the inside — surfacing to the learner as "Model not
     * loaded before trying to complete ChatCompletionRequest", which reads
     * like a programming error and tells them nothing they can act on.
     *
     * So the engine is rebuilt once and the request retried. The weights are
     * already in IndexedDB, which makes this a re-initialisation rather than a
     * re-download. Retried ONLY when nothing has been streamed yet: once
     * tokens have reached the caller, a retry would repeat them.
     */
    async #generateWithWebLlm(systemPrompt, userPrompt, maximumNewTokens, onToken, bAlreadyRebuilt = false)
    {
        let emittedTokenCount = 0;
        const countingOnToken = (deltaText) =>
        {
            emittedTokenCount++;
            onToken(deltaText);
        };

        try
        {
            return await this.#streamWebLlmCompletion(systemPrompt, userPrompt, maximumNewTokens, countingOnToken);
        }
        catch (generationError)
        {
            const errorMessage = generationError?.message || String(generationError);

            // Device loss is NOT retried here. The graphics adapter just failed
            // under real work, and rebuilding the same model on it walks
            // straight back into the same hang. It is marked and rethrown so
            // the session controller can retire the graphics backend for this
            // machine and come back on the processor one.
            if (BrowserLlmEngineRunner.DEVICE_LOST_ERROR_PATTERN.test(errorMessage))
            {
                generationError.name = BrowserLlmEngineRunner.DEVICE_LOST_ERROR_NAME;
                throw generationError;
            }

            const bRecoverable = !bAlreadyRebuilt
                && emittedTokenCount === 0
                && this.#loadedDescriptor !== null
                && BrowserLlmEngineRunner.MODEL_NOT_LOADED_ERROR_PATTERN.test(errorMessage);

            if (!bRecoverable)
            {
                throw generationError;
            }

            // Captured before unload(), which clears it.
            const descriptorToRestore = this.#loadedDescriptor;
            console.warn(`[BrowserLlmEngineRunner] Engine reported no loaded model — rebuilding "${descriptorToRestore.modelKey}" and retrying once.`);

            await this.unload();
            await this.#loadWebLlmEngine(descriptorToRestore, () => {});
            this.#loadedModelKey = descriptorToRestore.modelKey;
            this.#executionBackend = descriptorToRestore.executionBackend;
            this.#loadedDescriptor = descriptorToRestore;

            return await this.#generateWithWebLlm(systemPrompt, userPrompt, maximumNewTokens, onToken, true);
        }
    }

    async #streamWebLlmCompletion(systemPrompt, userPrompt, maximumNewTokens, onToken)
    {
        const completionStream = await this.#engine.chat.completions.create(
        {
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user",   content: userPrompt   }
            ],
            stream: true,
            temperature: BrowserLlmEngineRunner.GENERATION_TEMPERATURE,
            top_p: BrowserLlmEngineRunner.GENERATION_TOP_P,
            max_tokens: maximumNewTokens,
        });

        let completeText = "";
        for await (const completionChunk of completionStream)
        {
            const choices = completionChunk && completionChunk.choices;
            const deltaText = Array.isArray(choices) && choices.length > 0 && choices[0].delta
                ? choices[0].delta.content
                : "";
            if (typeof deltaText === "string" && deltaText.length > 0)
            {
                completeText += deltaText;
                onToken(deltaText);
            }
        }

        return completeText;
    }

    async #generateWithTransformers(systemPrompt, userPrompt, maximumNewTokens, onToken)
    {
        this.#stoppingCriteria = new Transformers.InterruptableStoppingCriteria();

        let completeText = "";
        const textStreamer = new Transformers.TextStreamer(this.#generationPipeline.tokenizer,
        {
            skip_prompt: true,
            skip_special_tokens: true,
            callback_function: (deltaText) =>
            {
                if (typeof deltaText === "string" && deltaText.length > 0)
                {
                    completeText += deltaText;
                    onToken(deltaText);
                }
            }
        });

        await this.#generationPipeline(
            [
                { role: "system", content: systemPrompt },
                { role: "user",   content: userPrompt   }
            ],
            {
                max_new_tokens: maximumNewTokens,
                temperature: BrowserLlmEngineRunner.GENERATION_TEMPERATURE,
                top_p: BrowserLlmEngineRunner.GENERATION_TOP_P,
                do_sample: true,
                return_full_text: false,
                streamer: textStreamer,
                stopping_criteria: this.#stoppingCriteria,
            }
        );

        this.#stoppingCriteria = null;
        return completeText;
    }

    /**
     * Stops an in-flight generation. Both engines finish the token they are
     * on, so the caller still sees a clean end of stream.
     */
    interrupt()
    {
        if (this.#stoppingCriteria)
        {
            this.#stoppingCriteria.interrupt();
            return;
        }
        if (this.#engine && typeof this.#engine.interruptGenerate === "function")
        {
            this.#engine.interruptGenerate();
        }
    }

    async unload()
    {
        if (this.#engine && typeof this.#engine.unload === "function")
        {
            try
            {
                await this.#engine.unload();
            }
            catch (unloadError)
            {
                console.warn(`[BrowserLlmEngineRunner] Engine unload failed: ${unloadError?.message || unloadError}`);
            }
        }
        if (this.#generationPipeline && typeof this.#generationPipeline.dispose === "function")
        {
            try
            {
                await this.#generationPipeline.dispose();
            }
            catch (disposeError)
            {
                console.warn(`[BrowserLlmEngineRunner] Pipeline dispose failed: ${disposeError?.message || disposeError}`);
            }
        }

        this.#engine = null;
        this.#generationPipeline = null;
        this.#stoppingCriteria = null;
        this.#loadedModelKey = null;
        this.#executionBackend = null;
        this.#loadedDescriptor = null;
    }
}

export default BrowserLlmEngineRunner;
