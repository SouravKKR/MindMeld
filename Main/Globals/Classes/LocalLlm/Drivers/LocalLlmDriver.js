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
}

export default LocalLlmDriver;
