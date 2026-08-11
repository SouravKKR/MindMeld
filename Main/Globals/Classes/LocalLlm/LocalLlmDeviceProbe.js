import LocalLlmDeviceProfile from "./LocalLlmDeviceProfile.js";
import LocalLlmDownloadConstants from "../../Constants/LocalLlmDownloadConstants.js";
import LocalLlmDriverFactory from "./Drivers/LocalLlmDriverFactory.js";
import Persistence from "../Persistence.js";
import { dataFormats } from "../../Enumerations/DataFormats.js";


/**
 * LocalLlmDeviceProbe
 *
 * Asks the platform, once, what this device can do, and hands back a
 * LocalLlmDeviceProfile. It reports facts and decides nothing — every
 * judgement about what those facts mean for a given model lives in
 * LocalLlmModelSelector, where it can be tested without a browser.
 *
 * Two details worth knowing:
 *
 *   - `navigator.gpu` merely existing proves nothing. Chromium exposes it on
 *     hardware where `requestAdapter()` then resolves to null, so the adapter
 *     is actually requested and its real limits and features are read.
 *
 *   - The `shader-f16` adapter feature decides whether the f16-quantised
 *     models can run at all. Many phone and older desktop GPUs lack it, which
 *     is exactly why the catalogue carries f32 variants alongside.
 */
class LocalLlmDeviceProbe
{
    static SHADER_F16_FEATURE_NAME = "shader-f16";

    static HANDHELD_USER_AGENT_PATTERN = /Android|iPhone|iPad|iPod|Windows Phone|Mobile|Tablet/i;

    static #cachedProfile = null;
    static #probePromise = null;

    /**
     * Resolves the device profile. Safe to await repeatedly — the adapter is
     * requested once per page load and the result is reused, because
     * requestAdapter is not free and several surfaces ask on mount.
     */
    static probe()
    {
        if (LocalLlmDeviceProbe.#probePromise)
        {
            return LocalLlmDeviceProbe.#probePromise;
        }

        LocalLlmDeviceProbe.#probePromise = (async () =>
        {
            const profile = await LocalLlmDeviceProbe.#buildProfile();
            LocalLlmDeviceProbe.#cachedProfile = profile;
            return profile;
        })();

        return LocalLlmDeviceProbe.#probePromise;
    }

    /**
     * The already-resolved profile, or null before probe() has settled. Lets
     * synchronous render paths read what is known without forcing a probe.
     */
    static getCachedProfile()
    {
        return LocalLlmDeviceProbe.#cachedProfile;
    }

    /**
     * A catalogue key forced through the URL, for reaching a model this
     * hardware would never be offered. Testing the no-f16 variant is
     * otherwise impossible on a machine whose GPU supports f16 — you cannot
     * choose your adapter's feature set.
     */
    static getForcedModelKey()
    {
        if (typeof window === "undefined" || !window.location)
        {
            return null;
        }

        try
        {
            const searchParameters = new URLSearchParams(window.location.search || "");
            const forcedModelKey = searchParameters.get(LocalLlmDownloadConstants.MODEL_OVERRIDE_QUERY_PARAMETER);
            return forcedModelKey && forcedModelKey.length > 0 ? forcedModelKey : null;
        }
        catch (parseError)
        {
            return null;
        }
    }

    /**
     * Records that this machine's GPU lost its device under a real model load,
     * and forgets the cached profile so the next probe reports the hardware as
     * graphics-incapable.
     *
     * An adapter that advertises ample limits can still fail the moment it is
     * asked to do the work: an integrated GPU driven past its watchdog timeout
     * reports DXGI_ERROR_DEVICE_HUNG and takes the WebGPU device with it,
     * after which every WebLLM object is disposed. No probe can predict that —
     * it is only knowable by having tried. So it is recorded once, device-wide,
     * and the selector then falls to the processor backend on its own: slower,
     * and it actually answers, which is the trade a machine like this wants.
     */
    static async recordGraphicsUnusable(reasonText)
    {
        LocalLlmDeviceProbe.#cachedProfile = null;
        LocalLlmDeviceProbe.#probePromise = null;
        try
        {
            await Persistence.write(
                LocalLlmDownloadConstants.LOCAL_GRAPHICS_UNUSABLE_PERSISTENCE_KEY,
                { unusable: true, reason: String(reasonText || "unknown"), at: Date.now() },
                dataFormats.JSON
            );
        }
        catch (writeError)
        {
            // The in-memory reset above already redirects THIS session to the
            // processor backend; persistence only carries it to the next one.
            console.warn(`[LocalLlmDeviceProbe] Could not persist the graphics-unusable flag: ${writeError?.message || writeError}`);
        }
    }

    static async #readGraphicsUnusableFlag()
    {
        try
        {
            const bExists = await Persistence.exists(LocalLlmDownloadConstants.LOCAL_GRAPHICS_UNUSABLE_PERSISTENCE_KEY);
            if (!bExists)
            {
                return false;
            }
            const record = await Persistence.read(
                LocalLlmDownloadConstants.LOCAL_GRAPHICS_UNUSABLE_PERSISTENCE_KEY,
                dataFormats.JSON
            );
            return Boolean(record && record.unusable === true);
        }
        catch (readError)
        {
            console.warn(`[LocalLlmDeviceProbe] Could not read the graphics-unusable flag: ${readError?.message || readError}`);
            return false;
        }
    }

    /**
     * Phone or tablet. The client hint is authoritative where it exists
     * (Chromium sets it from the platform, not from a spoofable string); the
     * user-agent match is the fallback for Firefox and Safari, which never
     * ship it. iPadOS deliberately reports itself as a Mac, so it is caught by
     * the touch-point count instead — a desktop reports 0.
     */
    static #detectHandheldDevice()
    {
        if (typeof navigator === "undefined")
        {
            return false;
        }

        if (navigator.userAgentData && typeof navigator.userAgentData.mobile === "boolean")
        {
            return navigator.userAgentData.mobile;
        }

        const userAgentText = typeof navigator.userAgent === "string" ? navigator.userAgent : "";
        if (LocalLlmDeviceProbe.HANDHELD_USER_AGENT_PATTERN.test(userAgentText))
        {
            return true;
        }

        // iPadOS masquerading as macOS.
        return /Macintosh/i.test(userAgentText)
            && typeof navigator.maxTouchPoints === "number"
            && navigator.maxTouchPoints > 1;
    }

    static async #buildProfile()
    {
        const bWebAssemblyAvailable = typeof WebAssembly === "object" && typeof WebAssembly.instantiate === "function";
        const deviceMemoryGigabytes = typeof navigator !== "undefined" && typeof navigator.deviceMemory === "number"
            ? navigator.deviceMemory
            : null;
        const hardwareConcurrency = typeof navigator !== "undefined" && typeof navigator.hardwareConcurrency === "number"
            ? navigator.hardwareConcurrency
            : 1;
        const bHandheldDevice = LocalLlmDeviceProbe.#detectHandheldDevice();

        // Asked before any graphics question, because it can change the answer
        // to all of them: a handheld with a native runtime is a supported
        // device, and the same handheld in a browser is not.
        const nativeCapability = await LocalLlmDriverFactory.probeNativeCapability();
        const nativeProfileFields =
        {
            bNativeDriverAvailable: nativeCapability !== null
                && nativeCapability.bAvailable === true
                && nativeCapability.bInferenceCompiledIn !== false,
            systemMemoryMegabytes: nativeCapability ? nativeCapability.systemMemoryMegabytes : null,
            logicalCoreCount: nativeCapability ? nativeCapability.logicalCoreCount : null,
        };

        // A GPU that has already lost its device on this machine is treated as
        // absent, not as merely under-specified: the limits it advertises were
        // never the problem.
        const bGraphicsProvenUnusable = await LocalLlmDeviceProbe.#readGraphicsUnusableFlag();

        if (typeof navigator === "undefined" || !navigator.gpu || bGraphicsProvenUnusable)
        {
            if (bGraphicsProvenUnusable)
            {
                console.warn("[LocalLlmDeviceProbe] Graphics previously lost its device on this machine — reporting WebGPU as unavailable so the processor backend is selected.");
            }
            return new LocalLlmDeviceProfile(
            {
                bWebGpuAvailable: false,
                bWebAssemblyAvailable: bWebAssemblyAvailable,
                deviceMemoryGigabytes: deviceMemoryGigabytes,
                hardwareConcurrency: hardwareConcurrency,
                bHandheldDevice: bHandheldDevice,
                ...nativeProfileFields,
            });
        }

        try
        {
            const adapter = await navigator.gpu.requestAdapter();
            if (!adapter)
            {
                return new LocalLlmDeviceProfile(
                {
                    bWebGpuAvailable: false,
                    bWebAssemblyAvailable: bWebAssemblyAvailable,
                    deviceMemoryGigabytes: deviceMemoryGigabytes,
                    hardwareConcurrency: hardwareConcurrency,
                    bHandheldDevice: bHandheldDevice,
                    ...nativeProfileFields,
                });
            }

            // A fallback adapter is WebGPU implemented in software (SwiftShader
            // on Windows). It answers every capability question well enough to
            // pass the catalogue's limit checks, then runs the model on the
            // processor anyway — through a graphics API, which is slower than
            // the processor backend proper and prone to exceeding the driver's
            // watchdog timeout, at which point the device is lost mid-answer.
            // Treated as no graphics at all, so the selector goes to the
            // processor backend directly instead of discovering this the
            // expensive way.
            if (adapter.isFallbackAdapter === true)
            {
                console.warn("[LocalLlmDeviceProbe] WebGPU is a software fallback adapter — reporting graphics as unavailable so the processor backend is chosen directly.");
                return new LocalLlmDeviceProfile(
                {
                    bWebGpuAvailable: false,
                    bWebAssemblyAvailable: bWebAssemblyAvailable,
                    deviceMemoryGigabytes: deviceMemoryGigabytes,
                    hardwareConcurrency: hardwareConcurrency,
                    bHandheldDevice: bHandheldDevice,
                    ...nativeProfileFields,
                });
            }

            const adapterLimits = adapter.limits || {};
            const adapterFeatures = adapter.features || null;

            return new LocalLlmDeviceProfile(
            {
                bWebGpuAvailable: true,
                bShaderF16Supported: Boolean(adapterFeatures && typeof adapterFeatures.has === "function"
                    && adapterFeatures.has(LocalLlmDeviceProbe.SHADER_F16_FEATURE_NAME)),
                maxBufferSizeBytes: typeof adapterLimits.maxBufferSize === "number" ? adapterLimits.maxBufferSize : 0,
                maxStorageBufferBindingSizeBytes: typeof adapterLimits.maxStorageBufferBindingSize === "number"
                    ? adapterLimits.maxStorageBufferBindingSize
                    : 0,
                deviceMemoryGigabytes: deviceMemoryGigabytes,
                bWebAssemblyAvailable: bWebAssemblyAvailable,
                hardwareConcurrency: hardwareConcurrency,
                bHandheldDevice: bHandheldDevice,
                ...nativeProfileFields,
                adapterDescription: typeof adapter.info === "object" && adapter.info
                    ? `${adapter.info.vendor || ""} ${adapter.info.architecture || ""}`.trim()
                    : "",
            });
        }
        catch (probeError)
        {
            // A rejected adapter request means no usable WebGPU, but the
            // processor backend may still be viable — so this is not fatal.
            console.warn(`[LocalLlmDeviceProbe] WebGPU adapter request failed: ${probeError?.message || probeError}`);
            return new LocalLlmDeviceProfile(
            {
                bWebGpuAvailable: false,
                bWebAssemblyAvailable: bWebAssemblyAvailable,
                deviceMemoryGigabytes: deviceMemoryGigabytes,
                hardwareConcurrency: hardwareConcurrency,
                bHandheldDevice: bHandheldDevice,
                ...nativeProfileFields,
            });
        }
    }
}

export default LocalLlmDeviceProbe;
