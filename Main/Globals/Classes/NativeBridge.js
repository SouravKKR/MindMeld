/**
 * NativeBridge
 *
 * The single place the app talks to the native shell it may be running inside.
 * Everything else — the on-device model driver above all — asks this class to
 * invoke a command or subscribe to an event, and never reaches for the shell's
 * own globals.
 *
 * The reason for the indirection is not tidiness, it is replaceability. The
 * shell is an implementation detail of "this is installed rather than visited":
 * it is Tauri today, it was a different wrapper before, and the native
 * inference work about to depend on it must not make that choice permanent.
 * With every call funnelled through here, swapping the shell is one file. With
 * the globals spread through the codebase it is an archaeology exercise.
 *
 * That is not a hypothetical. `window.__TAURI__` is already referenced directly
 * in Persistence, NativeDialog, GenerationNotifier, DeviceHeartbeatManager and
 * Platform — five unrelated classes that all had to learn the same defensive
 * shape. Those are left alone here (migrating them is its own change, and
 * Persistence in particular is load-bearing), but nothing new should join them.
 *
 * Everything degrades quietly in a plain browser: `isAvailable()` is false,
 * `invoke` rejects, `listen` resolves to a no-op unsubscribe. A caller that
 * forgets to check gets a rejected promise rather than a TypeError against
 * `undefined`, which is the difference between a handled failure and a blank
 * page.
 */
class NativeBridge
{
    // The shell exposes its command channel under `core` (v2) and exposed it
    // under `tauri` (v1). Both are read because an installed app updates on
    // its own schedule — a user on last year's binary is loading today's
    // frontend, and that pairing has to keep working.
    static #resolveCommandChannel()
    {
        if (typeof window === "undefined" || !window.__TAURI__)
        {
            return null;
        }
        return window.__TAURI__.core || window.__TAURI__.tauri || null;
    }

    static #resolveEventChannel()
    {
        if (typeof window === "undefined" || !window.__TAURI__)
        {
            return null;
        }
        return window.__TAURI__.event || null;
    }

    /**
     * Whether this page is running inside the native shell at all.
     *
     * Deliberately checks for the command channel rather than merely for
     * `window.__TAURI__`: the global can exist while the IPC surface does not
     * (an older shell, or a remote origin the shell has not granted access to),
     * and in that state every invoke would throw. Callers use this to choose a
     * path, so a false positive here is a broken feature rather than a
     * degraded one.
     */
    static isAvailable()
    {
        return NativeBridge.#resolveCommandChannel() !== null;
    }

    /**
     * Runs a command in the native process and resolves with its result.
     *
     * @param {string} commandName  the command's registered name
     * @param {object} payload      arguments, serialised across the boundary
     */
    static async invoke(commandName, payload = {})
    {
        const commandChannel = NativeBridge.#resolveCommandChannel();

        if (commandChannel === null || typeof commandChannel.invoke !== "function")
        {
            throw new Error(`The native bridge is unavailable, so "${commandName}" cannot run here.`);
        }

        return await commandChannel.invoke(commandName, payload);
    }

    /**
     * Subscribes to an event emitted by the native process.
     *
     * Resolves to an unsubscribe function — ALWAYS, including when there is no
     * bridge. Callers unsubscribe in a `finally`, and handing back a no-op
     * instead of null means that cleanup never has to be guarded. A listener
     * left attached across a long session is a real leak: the model driver
     * subscribes once per generation.
     */
    static async listen(eventName, eventHandler)
    {
        const eventChannel = NativeBridge.#resolveEventChannel();

        if (eventChannel === null || typeof eventChannel.listen !== "function")
        {
            return () => {};
        }

        const unsubscribe = await eventChannel.listen(eventName, eventHandler);
        return typeof unsubscribe === "function" ? unsubscribe : () => {};
    }
}

export default NativeBridge;
