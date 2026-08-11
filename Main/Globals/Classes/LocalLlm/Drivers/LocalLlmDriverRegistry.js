import BrowserWebGpuDriver from "./BrowserWebGpuDriver.js";
import NativeRuntimeDriver from "./NativeRuntimeDriver.js";
import { localLlmExecutionBackends } from "../../../Enumerations/LocalLlmExecutionBackends.js";


/**
 * LocalLlmDriverRegistry
 *
 * The table mapping an execution backend to the driver that implements it.
 * Nothing else in the codebase needs to know how many drivers exist or what
 * they are called.
 *
 * The table is the extension point. Supporting a new way of running a model —
 * a different native library, a process on localhost, a future browser API —
 * is one driver class and one line below, because everything downstream keys
 * off the backend declared in the model catalogue rather than off a branch in
 * the selection code. That is the same principle the catalogue already applies
 * to models: what the system can run is data, not control flow.
 *
 * One instance per backend, held for the life of the page. A driver owns an
 * engine and the weights it has loaded — well over a gigabyte — so handing out
 * a fresh instance per call would not be wasteful, it would be an
 * out-of-memory crash.
 */
class LocalLlmDriverRegistry
{
    static #driversByBackend = new Map([
        [localLlmExecutionBackends.WEBGPU, new BrowserWebGpuDriver()],
        [localLlmExecutionBackends.NATIVE_RUNTIME, new NativeRuntimeDriver()],
    ]);

    /**
     * The driver registered for a backend, or null when nothing implements it.
     *
     * Null rather than a throw: an unimplemented backend is a legitimate state
     * — WASM still has an enum value and no driver, because that path was
     * withdrawn — and the selector needs to be able to ask without handling an
     * exception.
     */
    static getDriverForBackend(executionBackendValue)
    {
        const driver = LocalLlmDriverRegistry.#driversByBackend.get(executionBackendValue);
        return driver === undefined ? null : driver;
    }

    static hasDriverForBackend(executionBackendValue)
    {
        return LocalLlmDriverRegistry.#driversByBackend.has(executionBackendValue);
    }

    static getRegisteredBackends()
    {
        return Array.from(LocalLlmDriverRegistry.#driversByBackend.keys());
    }
}

export default LocalLlmDriverRegistry;
