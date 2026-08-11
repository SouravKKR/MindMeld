import LocalLlmDriver from "./LocalLlmDriver.js";
import LocalLlmEngineClient from "../LocalLlmEngineClient.js";


/**
 * BrowserWebGpuDriver
 *
 * Runs the model in the page, on the device's graphics hardware, through the
 * worker that LocalLlmEngineClient owns.
 *
 * It is a thin adapter and should stay one. All the substance — the single
 * worker, the request-id correlation, the main-thread fallback when module
 * workers are unavailable, the device-lost marker crossing the worker boundary
 * — already lives in the engine client and is unchanged by the arrival of a
 * second driver. Reimplementing any of it here would fork behaviour that took
 * a while to get right.
 *
 * `probeCapability` reports availability only. The real graphics facts — the
 * adapter's limits, shader-f16, whether this machine has already lost its
 * device once — come from LocalLlmDeviceProbe, which asks the platform
 * directly and has done since before drivers existed. Duplicating that here
 * would give the selector two sources for the same question.
 */
class BrowserWebGpuDriver extends LocalLlmDriver
{
    async probeCapability()
    {
        return {
            bAvailable: typeof navigator !== "undefined" && Boolean(navigator.gpu),
            systemMemoryMegabytes: null,
            logicalCoreCount: typeof navigator !== "undefined" && Number.isFinite(navigator.hardwareConcurrency)
                ? navigator.hardwareConcurrency
                : null,
            bMobileDevice: false,
            accelerationLabel: "WebGPU",
        };
    }

    async load(descriptor, onProgress)
    {
        await LocalLlmEngineClient.load(descriptor, onProgress);
    }

    async generate(request, onToken)
    {
        return await LocalLlmEngineClient.generate(request, onToken);
    }

    interrupt()
    {
        LocalLlmEngineClient.interrupt();
    }

    unload()
    {
        LocalLlmEngineClient.terminate();
    }

    isReady()
    {
        return LocalLlmEngineClient.isEngineReady();
    }
}

export default BrowserWebGpuDriver;
