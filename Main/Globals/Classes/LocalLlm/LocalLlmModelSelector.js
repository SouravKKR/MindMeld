import LocalLlmModelCatalogue from "../../Constants/LocalLlmModelCatalogue.js";
import LocalLlmSelectionOutcome from "./LocalLlmSelectionOutcome.js";
import { localLlmExecutionBackends } from "../../Enumerations/LocalLlmExecutionBackends.js";
import { localLlmUnavailableReasons } from "../../Enumerations/LocalLlmUnavailableReasons.js";


/**
 * LocalLlmModelSelector
 *
 * Decides which Free-tier model this device should run. It is deliberately
 * generic: it knows nothing about Qwen, about parameter counts, or about how
 * many models exist. Everything it reasons over comes from
 * Common/Constants/LocalLlmModelCatalogue.json — a model's backend, its
 * declared device requirements, and its preference rank.
 *
 * That genericity is the point. Supporting a wider set of phones later, or
 * swapping the processor-backed model for a smaller one, means adding a
 * catalogue entry at the right `preferenceRank` and provisioning it. No code
 * here changes.
 *
 * Every threshold is per-model rather than global. The predecessor applied a
 * single 1 GiB storage-binding floor to the whole feature, which is above what
 * many phone GPUs report — so a phone that could comfortably have run a
 * smaller model was told its device could not run the Free tier at all.
 * Filtering per entry means that phone simply lands on the next model down.
 *
 * Pure by construction: no DOM, no persistence, no network. The device is
 * described by a LocalLlmDeviceProfile the caller supplies, and the
 * provisioned set by a list of catalogue keys. Keep it that way — it is what
 * lets the whole selection matrix be exercised under Node.
 */
class LocalLlmModelSelector
{
    /**
     * @param {LocalLlmDeviceProfile} deviceProfile     what this device can do
     * @param {string[]}                availableModelKeys catalogue keys the server has provisioned
     * @param {string|null}             forcedModelKey     manual override, for testing a model
     *                                                     this hardware would not otherwise pick
     *
     * @returns {LocalLlmSelectionOutcome}
     */
    static select(deviceProfile, availableModelKeys, forcedModelKey = null)
    {
        const orderedKeys = Array.isArray(LocalLlmModelCatalogue.ORDER) ? LocalLlmModelCatalogue.ORDER : [];
        const availableKeySet = new Set(Array.isArray(availableModelKeys) ? availableModelKeys : []);

        if (availableKeySet.size === 0)
        {
            return new LocalLlmSelectionOutcome({ unavailableReason: localLlmUnavailableReasons.NO_MODEL_PROVISIONED });
        }

        // The override skips every requirement check on purpose: its whole job
        // is reaching a rung this hardware would not otherwise be offered, so
        // a device with shader-f16 can still be used to test the model meant
        // for devices without it.
        if (forcedModelKey && availableKeySet.has(forcedModelKey) && LocalLlmModelCatalogue[forcedModelKey])
        {
            return new LocalLlmSelectionOutcome({ modelKey: forcedModelKey, preferredModelKey: forcedModelKey });
        }

        const candidateKeys = [];
        let bAnyBackendSupported = false;
        let bAnyBlockedByGpuLimits = false;
        let bAnyBlockedByDeviceMemory = false;
        let bAnyBlockedByHandheld = false;

        for (const modelKey of orderedKeys)
        {
            if (!availableKeySet.has(modelKey))
            {
                continue;
            }

            const descriptor = LocalLlmModelCatalogue[modelKey];
            if (!descriptor)
            {
                continue;
            }

            if (!LocalLlmModelSelector.#isBackendSupported(descriptor, deviceProfile))
            {
                continue;
            }
            bAnyBackendSupported = true;

            if (!LocalLlmModelSelector.#isHandheldAllowedToRun(descriptor, deviceProfile))
            {
                bAnyBlockedByHandheld = true;
                continue;
            }

            if (!LocalLlmModelSelector.#areGpuRequirementsMet(descriptor, deviceProfile))
            {
                bAnyBlockedByGpuLimits = true;
                continue;
            }

            if (!LocalLlmModelSelector.#isDeviceMemorySufficient(descriptor, deviceProfile))
            {
                bAnyBlockedByDeviceMemory = true;
                continue;
            }
            if (!LocalLlmModelSelector.#isSystemMemorySufficient(descriptor, deviceProfile))
            {
                bAnyBlockedByDeviceMemory = true;
                continue;
            }

            candidateKeys.push(modelKey);
        }

        if (candidateKeys.length === 0)
        {
            return new LocalLlmSelectionOutcome(
            {
                unavailableReason: LocalLlmModelSelector.#resolveUnavailableReason(
                    bAnyBackendSupported,
                    bAnyBlockedByGpuLimits,
                    bAnyBlockedByDeviceMemory,
                    bAnyBlockedByHandheld
                )
            });
        }

        candidateKeys.sort((firstKey, secondKey) =>
            LocalLlmModelSelector.#rankOf(firstKey) - LocalLlmModelSelector.#rankOf(secondKey));

        const chosenModelKey = candidateKeys[0];
        const preferredModelKey = LocalLlmModelSelector.#findPreferredModelKey(orderedKeys, availableKeySet, deviceProfile);

        return new LocalLlmSelectionOutcome(
        {
            modelKey: chosenModelKey,
            preferredModelKey: preferredModelKey,
            degradeNote: LocalLlmModelCatalogue[chosenModelKey].displayNote || null
        });
    }

    /**
     * The best model this DEVICE could have been given, had nothing but its
     * capability limits stood in the way. Comparing the chosen model against it
     * is what tells a learner they are running a compromise.
     *
     * Restricted to backends this device can actually execute, which matters
     * now that the catalogue carries models only the installed app can run. A
     * browser can never run a native entry, so counting one as "preferred"
     * would mark every browser visitor as degraded and attach an apology to
     * the best model they can possibly have — precisely the noise this flag
     * exists to avoid.
     */
    static #findPreferredModelKey(orderedKeys, availableKeySet, deviceProfile)
    {
        let preferredModelKey = null;
        let preferredRank = Number.POSITIVE_INFINITY;

        for (const modelKey of orderedKeys)
        {
            const descriptor = LocalLlmModelCatalogue[modelKey];
            if (!availableKeySet.has(modelKey) || !descriptor)
            {
                continue;
            }
            if (!LocalLlmModelSelector.#isBackendSupported(descriptor, deviceProfile))
            {
                continue;
            }
            const rank = LocalLlmModelSelector.#rankOf(modelKey);
            if (rank < preferredRank)
            {
                preferredRank = rank;
                preferredModelKey = modelKey;
            }
        }

        return preferredModelKey;
    }

    static #isBackendSupported(descriptor, deviceProfile)
    {
        const backendValue = localLlmExecutionBackends[descriptor.executionBackend];

        if (backendValue === localLlmExecutionBackends.WEBGPU)
        {
            return deviceProfile.isWebGpuAvailable();
        }
        if (backendValue === localLlmExecutionBackends.NATIVE_RUNTIME)
        {
            return deviceProfile.isNativeDriverAvailable();
        }
        if (backendValue === localLlmExecutionBackends.WASM)
        {
            return deviceProfile.isWebAssemblyAvailable();
        }
        return false;
    }

    /**
     * Whether a handheld may run this particular model.
     *
     * The refusal is per backend rather than per device, which is the whole
     * point. A phone running a model through the browser's graphics stack is a
     * bad bet — thermally throttled within a minute, visibly draining, and a
     * tab that idles has its GPU resources reclaimed mid-answer. A phone
     * running compiled code with the app in the foreground is the ordinary
     * case for every on-device assistant that works, so the same hardware is
     * allowed here and refused above purely on how the model would be
     * executed.
     */
    static #isHandheldAllowedToRun(descriptor, deviceProfile)
    {
        if (!deviceProfile.isHandheldDevice())
        {
            return true;
        }
        return localLlmExecutionBackends[descriptor.executionBackend] === localLlmExecutionBackends.NATIVE_RUNTIME;
    }

    /**
     * System memory, for models that run in the app's own process.
     *
     * Distinct from the browser's `deviceMemory` hint: that one is coarse,
     * capped at 8 by Chromium and absent entirely in Firefox and Safari, while
     * the native runtime reports the real figure. As everywhere else here, a
     * figure that was not reported never disqualifies a model.
     */
    static #isSystemMemorySufficient(descriptor, deviceProfile)
    {
        const requiredMegabytes = descriptor.minimumSystemMemoryMegabytes || 0;
        if (requiredMegabytes <= 0)
        {
            return true;
        }

        const reportedMegabytes = deviceProfile.getSystemMemoryMegabytes();
        if (reportedMegabytes === null)
        {
            return true;
        }
        return reportedMegabytes >= requiredMegabytes;
    }

    static #areGpuRequirementsMet(descriptor, deviceProfile)
    {
        if (localLlmExecutionBackends[descriptor.executionBackend] !== localLlmExecutionBackends.WEBGPU)
        {
            return true;
        }

        if (descriptor.requiresShaderF16 === true && !deviceProfile.isShaderF16Supported())
        {
            return false;
        }
        if (deviceProfile.getMaxBufferSizeBytes() < (descriptor.minimumMaxBufferSizeBytes || 0))
        {
            return false;
        }
        if (deviceProfile.getMaxStorageBufferBindingSizeBytes() < (descriptor.minimumMaxStorageBufferBindingSizeBytes || 0))
        {
            return false;
        }
        return true;
    }

    /**
     * A device-memory figure the browser refuses to report never disqualifies
     * a model. Firefox and Safari never report it at all, so treating the
     * absence as "too small" would rule out every non-Chromium desktop.
     */
    static #isDeviceMemorySufficient(descriptor, deviceProfile)
    {
        const reportedGigabytes = deviceProfile.getDeviceMemoryGigabytes();
        if (reportedGigabytes === null)
        {
            return true;
        }
        return reportedGigabytes >= (descriptor.minimumDeviceMemoryGigabytes || 0);
    }

    /**
     * The most specific explanation the evidence supports. GPU limits beat a
     * memory shortfall because the limits are a hard fact the adapter
     * reported, whereas the memory figure is a coarse browser hint.
     */
    static #resolveUnavailableReason(bAnyBackendSupported, bAnyBlockedByGpuLimits, bAnyBlockedByDeviceMemory, bAnyBlockedByHandheld)
    {
        if (!bAnyBackendSupported)
        {
            return localLlmUnavailableReasons.NO_SUPPORTED_BACKEND;
        }
        // Ahead of the limit reasons because it is the actionable one. A phone
        // whose browser cannot run this is not short of memory or graphics
        // headroom — it needs the app, and saying "your GPU limits are too low"
        // sends the learner to look for a setting that would not help.
        if (bAnyBlockedByHandheld)
        {
            return localLlmUnavailableReasons.HANDHELD_DEVICE;
        }
        if (bAnyBlockedByGpuLimits)
        {
            return localLlmUnavailableReasons.GPU_LIMITS_TOO_LOW;
        }
        if (bAnyBlockedByDeviceMemory)
        {
            return localLlmUnavailableReasons.DEVICE_MEMORY_TOO_LOW;
        }
        return localLlmUnavailableReasons.NO_MODEL_PROVISIONED;
    }

    static #rankOf(modelKey)
    {
        const descriptor = LocalLlmModelCatalogue[modelKey];
        return descriptor && Number.isFinite(descriptor.preferenceRank)
            ? descriptor.preferenceRank
            : Number.POSITIVE_INFINITY;
    }

    /**
     * The catalogue descriptor for a key, or null. Callers outside the
     * selector read display fields (parameter label, size label, context
     * window) through this so nothing else has to import the catalogue.
     */
    static getDescriptor(modelKey)
    {
        return modelKey && LocalLlmModelCatalogue[modelKey] ? LocalLlmModelCatalogue[modelKey] : null;
    }
}

export default LocalLlmModelSelector;
