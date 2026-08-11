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
        // Phones and tablets are out, ahead of every capability check, because
        // the question they fail is not a capability one. A handheld can hold
        // the weights and satisfy the limits and still be the wrong place to
        // run this: sustained inference is thermally throttled within a minute,
        // it drains the battery visibly, and a browser tab that idles gets its
        // GPU resources reclaimed mid-answer. The tier is offered where it can
        // be relied on rather than merely started.
        if (deviceProfile.isHandheldDevice())
        {
            return new LocalLlmSelectionOutcome({ unavailableReason: localLlmUnavailableReasons.HANDHELD_DEVICE });
        }

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

            candidateKeys.push(modelKey);
        }

        if (candidateKeys.length === 0)
        {
            return new LocalLlmSelectionOutcome(
            {
                unavailableReason: LocalLlmModelSelector.#resolveUnavailableReason(
                    bAnyBackendSupported,
                    bAnyBlockedByGpuLimits,
                    bAnyBlockedByDeviceMemory
                )
            });
        }

        candidateKeys.sort((firstKey, secondKey) =>
            LocalLlmModelSelector.#rankOf(firstKey) - LocalLlmModelSelector.#rankOf(secondKey));

        const chosenModelKey = candidateKeys[0];
        const preferredModelKey = LocalLlmModelSelector.#findPreferredModelKey(orderedKeys, availableKeySet);

        return new LocalLlmSelectionOutcome(
        {
            modelKey: chosenModelKey,
            preferredModelKey: preferredModelKey,
            degradeNote: LocalLlmModelCatalogue[chosenModelKey].displayNote || null
        });
    }

    /**
     * The best model the catalogue offers on this deployment regardless of
     * device. Comparing the chosen model against it is what tells a learner
     * they are running a compromise.
     */
    static #findPreferredModelKey(orderedKeys, availableKeySet)
    {
        let preferredModelKey = null;
        let preferredRank = Number.POSITIVE_INFINITY;

        for (const modelKey of orderedKeys)
        {
            if (!availableKeySet.has(modelKey) || !LocalLlmModelCatalogue[modelKey])
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
        if (backendValue === localLlmExecutionBackends.WASM)
        {
            return deviceProfile.isWebAssemblyAvailable();
        }
        return false;
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
    static #resolveUnavailableReason(bAnyBackendSupported, bAnyBlockedByGpuLimits, bAnyBlockedByDeviceMemory)
    {
        if (!bAnyBackendSupported)
        {
            return localLlmUnavailableReasons.NO_SUPPORTED_BACKEND;
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
