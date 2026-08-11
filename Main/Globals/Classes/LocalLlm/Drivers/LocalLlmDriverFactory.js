import LocalLlmDriverRegistry from "./LocalLlmDriverRegistry.js";
import { localLlmExecutionBackends } from "../../../Enumerations/LocalLlmExecutionBackends.js";


/**
 * LocalLlmDriverFactory
 *
 * Decides which driver runs a given model, and answers the one question the
 * device probe needs before any model has been chosen: can this device run
 * anything natively?
 *
 * The registry is the table; this is the policy. Keeping them apart means
 * adding a backend touches the table only, while changing how a backend is
 * chosen touches this file only.
 *
 * Resolution is driven entirely by the descriptor. The model the selector
 * picked declares its own backend, so there is no independent "which driver
 * are we on" state that could disagree with "which model is loaded" — a
 * disagreement that would surface as a native descriptor being handed to the
 * browser engine, which fails deep inside a worker with an unhelpful message.
 */
class LocalLlmDriverFactory
{
    static #nativeCapability = null;
    static #nativeProbePromise = null;

    /**
     * The driver that must run `descriptor`, or null when this deployment has
     * no implementation for the backend it declares.
     */
    static resolveForDescriptor(descriptor)
    {
        const backendValue = LocalLlmDriverFactory.#resolveBackendValue(descriptor);
        if (backendValue === null)
        {
            return null;
        }
        return LocalLlmDriverRegistry.getDriverForBackend(backendValue);
    }

    /**
     * A manifest descriptor carries its backend as a key NAME, because that is
     * what the catalogue JSON holds and what the server echoes back; the enum
     * is numeric. Both forms are accepted so neither side has to convert.
     */
    static #resolveBackendValue(descriptor)
    {
        const declaredBackend = descriptor?.executionBackend;

        if (typeof declaredBackend === "number")
        {
            return declaredBackend;
        }
        if (typeof declaredBackend === "string" && localLlmExecutionBackends[declaredBackend] !== undefined)
        {
            return localLlmExecutionBackends[declaredBackend];
        }
        return null;
    }

    /**
     * What the native runtime can do on this device, or null when there is no
     * native runtime here (an ordinary browser, or an installed shell built
     * before the inference commands existed).
     *
     * Probed once and memoised. The device probe, the capability surface and
     * the tier picker all ask, and the answer cannot change without the app
     * being restarted — the shell either exposes the commands or it does not.
     */
    static async probeNativeCapability()
    {
        if (LocalLlmDriverFactory.#nativeProbePromise !== null)
        {
            return await LocalLlmDriverFactory.#nativeProbePromise;
        }

        LocalLlmDriverFactory.#nativeProbePromise = (async () =>
        {
            const nativeDriver = LocalLlmDriverRegistry.getDriverForBackend(localLlmExecutionBackends.NATIVE_RUNTIME);
            if (nativeDriver === null)
            {
                return null;
            }

            LocalLlmDriverFactory.#nativeCapability = await nativeDriver.probeCapability();
            return LocalLlmDriverFactory.#nativeCapability;
        })();

        return await LocalLlmDriverFactory.#nativeProbePromise;
    }

    /**
     * The memoised capability without forcing a probe, for synchronous render
     * paths that want to show what is already known rather than block.
     */
    static getProbedNativeCapability()
    {
        return LocalLlmDriverFactory.#nativeCapability;
    }

    /**
     * Forgets the probe. Exists for the verification harness, which exercises
     * several device shapes in one process and would otherwise see the first
     * one's answer for all of them.
     */
    static resetProbe()
    {
        LocalLlmDriverFactory.#nativeCapability = null;
        LocalLlmDriverFactory.#nativeProbePromise = null;
    }
}

export default LocalLlmDriverFactory;
