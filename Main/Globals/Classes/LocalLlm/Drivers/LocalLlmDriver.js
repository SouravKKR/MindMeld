/**
 * LocalLlmDriver
 *
 * The contract every on-device execution path implements. One driver owns one
 * engine and one loaded model; LocalLlmSessionController owns one driver and is
 * the only thing that calls these methods.
 *
 * It is written in engine-neutral terms on purpose. Nothing here says WebGPU,
 * WebLLM, GGUF or llama.cpp; it speaks in descriptors, bytes and tokens. That
 * is what lets a second implementation appear without the layers above it
 * learning a second vocabulary — LocalAskAiRunner, the Ask AI dialog, deck
 * chat and the tier picker all sit above the session controller and cannot
 * tell which driver answered them.
 *
 * The transport is equally deliberately unspecified. Today one driver reaches
 * its engine through a web worker and another through a native command
 * channel; a future one could reach a process on localhost. All three are the
 * same shape from here, which is what keeps that option open without a
 * redesign.
 *
 * JavaScript has no interfaces, so this is a base class whose methods throw.
 * Throwing rather than returning empty is the point: a half-implemented driver
 * fails loudly at the call that is missing, instead of silently reporting that
 * a model produced no tokens.
 */
class LocalLlmDriver
{
    /**
     * What this execution path can do on this device, or null when the path is
     * unavailable here. Called before anything is loaded — the selector uses
     * it to decide whether this driver's models are even candidates.
     *
     * Shape:
     *   {
     *       bAvailable:            boolean,
     *       systemMemoryMegabytes: number|null,
     *       logicalCoreCount:      number|null,
     *       bMobileDevice:         boolean,
     *       accelerationLabel:     string
     *   }
     *
     * A null figure means "not reported", never "zero". The distinction
     * matters: the selector must not disqualify a model on evidence it does
     * not have.
     *
     * @returns {Promise<object|null>}
     */
    async probeCapability()
    {
        throw new Error(`${this.constructor.name} does not implement probeCapability().`);
    }

    /**
     * Makes `descriptor`'s model ready to answer, fetching it first if the
     * device does not already hold it.
     *
     * `onProgress` receives `{ fraction, loadedBytes, totalBytes, statusText }`
     * throughout. Byte-denominated rather than a bare fraction because the
     * caller renders a real download — up to a couple of gigabytes — and
     * "47%" with no idea of the total is not something a learner can plan
     * around.
     *
     * @param {object}   descriptor  the manifest entry for the chosen model
     * @param {Function} onProgress
     */
    async load(descriptor, onProgress)
    {
        throw new Error(`${this.constructor.name} does not implement load().`);
    }

    /**
     * Gets `descriptor`'s weights onto the device WITHOUT promising that the
     * model is ready to answer, and without disturbing whichever model is
     * loaded now.
     *
     * It exists because acquiring and using are separate acts for a learner:
     * fetching the 3B while continuing to ask questions of the 1.5B is an
     * ordinary thing to want, and `load()` cannot express it — one engine
     * holds one model, so loading the new one displaces the old.
     *
     * A driver whose engine has no separate fetch step may implement this as
     * `load()`; the contract asks for the weights to be present afterwards,
     * not for them to be absent from the engine. What it must NOT do is
     * promise readiness, because callers use this to pre-fetch models they are
     * not switching to.
     *
     * @param {object}   descriptor
     * @param {Function} onProgress  same shape as load()'s
     */
    async download(descriptor, onProgress)
    {
        throw new Error(`${this.constructor.name} does not implement download().`);
    }

    /**
     * Streams a completion, calling `onToken` with each fragment as it
     * arrives, and resolving with the complete text.
     *
     * Both halves are required. The stream is what the learner watches; the
     * resolved string is what the caller stores, and reassembling it from the
     * fragments at every call site would duplicate that logic per driver.
     *
     * @param {object}   request  the built prompt
     * @param {Function} onToken
     * @returns {Promise<string>}
     */
    async generate(request, onToken)
    {
        throw new Error(`${this.constructor.name} does not implement generate().`);
    }

    /**
     * Asks the engine to stop generating.
     *
     * Fire-and-forget, and NOT an error path: the in-flight `generate()`
     * resolves normally with whatever was produced, so a learner who closes
     * the dialog sees a clean end of stream rather than a failure. It must
     * genuinely stop the work — on a phone an abandoned generation is heat and
     * battery, not just wasted output.
     */
    interrupt()
    {
        throw new Error(`${this.constructor.name} does not implement interrupt().`);
    }

    /**
     * Releases the engine and the weights it holds. Called when switching
     * models or recovering from a failed device; the next `load()` starts over.
     */
    unload()
    {
        throw new Error(`${this.constructor.name} does not implement unload().`);
    }

    /**
     * Whether a model is loaded and able to answer right now.
     * @returns {boolean}
     */
    isReady()
    {
        throw new Error(`${this.constructor.name} does not implement isReady().`);
    }

    /**
     * Whether this device already holds `descriptor`'s weights, asked of the
     * store that actually holds them.
     *
     * This exists because the app's own record of what it downloaded is a
     * belief, not a fact. A browser can evict an origin's cache under storage
     * pressure, a learner can clear site data, and an app's data directory can
     * be emptied by the operating system or by hand — none of which tell the
     * app anything. Believing the record over the store is what makes an
     * application insist a model is ready and then fail to load it.
     *
     * Returning `null` means "cannot tell" — an older app shell that does not
     * implement the query, say — and is deliberately distinct from `false`.
     * The caller keeps its recorded belief when the answer is null, and
     * corrects it only on a definite one.
     *
     * @param {object} descriptor
     * @returns {Promise<boolean|null>}
     */
    async hasModel(descriptor)
    {
        throw new Error(`${this.constructor.name} does not implement hasModel().`);
    }

    /**
     * Removes `descriptor`'s weights from wherever this driver put them, and
     * resolves once the space is actually reclaimed.
     *
     * Deleting the model that is currently loaded must also unload it: the
     * caller does that before calling here, because a driver holding open
     * handles to files it is deleting behaves differently on every platform.
     *
     * It must reject rather than resolve when the removal did not happen. A
     * silent failure here reads to the caller as reclaimed space, and the
     * learner is told a couple of gigabytes were freed while the disk says
     * otherwise.
     *
     * @param {object} descriptor
     */
    async deleteModel(descriptor)
    {
        throw new Error(`${this.constructor.name} does not implement deleteModel().`);
    }
}

export default LocalLlmDriver;
