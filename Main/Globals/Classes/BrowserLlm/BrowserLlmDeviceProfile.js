/**
 * BrowserLlmDeviceProfile
 *
 * A plain snapshot of what this device can do, with no opinion about what
 * that means. BrowserLlmDeviceProbe fills one in by asking the platform;
 * BrowserLlmModelSelector reads one to decide which catalogue model to load.
 *
 * Keeping the two apart is what makes the selection testable: the selector
 * never touches `navigator`, so every device shape — a desktop discrete GPU,
 * a mid-range phone reporting the WebGPU spec minimums, a browser with no
 * WebGPU at all — is just a profile literal in a test.
 *
 * `deviceMemoryGigabytes` is null whenever the browser declines to report it
 * (Firefox and Safari never do, and Chromium caps the value at 8). Null means
 * "unknown", and unknown must never be treated as "too small" — absence of
 * evidence is not evidence of a weak device.
 */
class BrowserLlmDeviceProfile
{
    #bWebGpuAvailable = false;
    #bShaderF16Supported = false;
    #maxBufferSizeBytes = 0;
    #maxStorageBufferBindingSizeBytes = 0;
    #deviceMemoryGigabytes = null;
    #bWebAssemblyAvailable = false;
    #hardwareConcurrency = 1;
    #adapterDescription = "";
    #bHandheldDevice = false;

    constructor(
    {
        bWebGpuAvailable = false,
        bShaderF16Supported = false,
        maxBufferSizeBytes = 0,
        maxStorageBufferBindingSizeBytes = 0,
        deviceMemoryGigabytes = null,
        bWebAssemblyAvailable = false,
        hardwareConcurrency = 1,
        adapterDescription = "",
        bHandheldDevice = false,
    } = {})
    {
        this.#bWebGpuAvailable = bWebGpuAvailable === true;
        this.#bShaderF16Supported = bShaderF16Supported === true;
        this.#maxBufferSizeBytes = Number.isFinite(maxBufferSizeBytes) ? maxBufferSizeBytes : 0;
        this.#maxStorageBufferBindingSizeBytes = Number.isFinite(maxStorageBufferBindingSizeBytes) ? maxStorageBufferBindingSizeBytes : 0;
        this.#deviceMemoryGigabytes = Number.isFinite(deviceMemoryGigabytes) && deviceMemoryGigabytes > 0 ? deviceMemoryGigabytes : null;
        this.#bWebAssemblyAvailable = bWebAssemblyAvailable === true;
        this.#hardwareConcurrency = Number.isFinite(hardwareConcurrency) && hardwareConcurrency > 0 ? hardwareConcurrency : 1;
        this.#adapterDescription = typeof adapterDescription === "string" ? adapterDescription : "";
        this.#bHandheldDevice = bHandheldDevice === true;
    }

    /**
     * Whether this is a phone or tablet. Reported, not judged — what it means
     * for a given model is the selector's call.
     */
    isHandheldDevice()
    {
        return this.#bHandheldDevice;
    }

    isWebGpuAvailable()
    {
        return this.#bWebGpuAvailable;
    }

    isShaderF16Supported()
    {
        return this.#bShaderF16Supported;
    }

    getMaxBufferSizeBytes()
    {
        return this.#maxBufferSizeBytes;
    }

    getMaxStorageBufferBindingSizeBytes()
    {
        return this.#maxStorageBufferBindingSizeBytes;
    }

    /**
     * Gigabytes of RAM the browser admits to, or null when it will not say.
     */
    getDeviceMemoryGigabytes()
    {
        return this.#deviceMemoryGigabytes;
    }

    isWebAssemblyAvailable()
    {
        return this.#bWebAssemblyAvailable;
    }

    getHardwareConcurrency()
    {
        return this.#hardwareConcurrency;
    }

    getAdapterDescription()
    {
        return this.#adapterDescription;
    }
}

export default BrowserLlmDeviceProfile;
