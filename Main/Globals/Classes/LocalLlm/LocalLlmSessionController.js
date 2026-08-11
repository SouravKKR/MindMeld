import LocalLlmDeviceProbe from "./LocalLlmDeviceProbe.js";
import LocalLlmEngineClient from "./LocalLlmEngineClient.js";
import LocalLlmManifestClient from "./LocalLlmManifestClient.js";
import LocalLlmModelSelector from "./LocalLlmModelSelector.js";


/**
 * LocalLlmSessionController
 *
 * The single front door to the on-device model. Everything else — the
 * download manager, the Ask AI runner, deck chat — goes through
 * `ensureReady()` and never touches the probe, the manifest or the engine
 * directly.
 *
 * The reason it exists is concurrency. Two paths can both want the model
 * loaded: the explicit download the learner starts from the tier picker, and
 * a query issued the moment it finishes. Without a shared in-flight promise
 * those race into two engine loads, and two copies of a gigabyte of weights
 * is an out-of-memory crash rather than a slowdown.
 *
 * It also owns the resolution result, so "which model is this device on" has
 * one answer that the picker label, the progress bar and the prompt budget
 * all read.
 */
class LocalLlmSessionController
{
    // Mirrors BrowserLlmEngineRunner.DEVICE_LOST_ERROR_NAME by hand, for the
    // same reason BrowserLlmWorkerProtocol.js mirrors its two enums: this file
    // is bundled, the runner is not, and importing the runner from here would
    // drag the 6.8 MB vendor bundle into the SPA bundle with it. Changing it in
    // one place means changing it in both.
    //
    // The runner still carries the older BrowserLlm* class and directory names
    // on purpose — Main/ThirdParty/BrowserLlm/ is excluded from bundling and
    // obfuscation BY PATH, and the worker is fetched by that literal URL at
    // run time — so this mirror deliberately spans two naming generations.
    // The value below is compared against `error.name` coming back across the
    // worker boundary; if the two strings ever disagree a lost GPU device
    // stops being recognised and silently degrades into an ordinary failure,
    // losing the fallback entirely. VerifyLocalLlmProvisioning.mjs asserts
    // they match.
    static DEVICE_LOST_ERROR_NAME = "LocalLlmDeviceLostError";

    static #readyPromise = null;
    static #selectionOutcome = null;
    static #activeDescriptor = null;

    /**
     * Probes the device, reads the manifest, selects a model and loads it.
     * Resolves to the loaded descriptor.
     *
     * Repeated calls share one load. `onProgress` is honoured on whichever
     * call actually drives the load; a caller arriving mid-load simply waits.
     */
    static ensureReady(onProgress = null)
    {
        if (LocalLlmSessionController.#readyPromise)
        {
            return LocalLlmSessionController.#readyPromise;
        }

        LocalLlmSessionController.#readyPromise = (async () =>
        {
            const loadOnce = async () =>
            {
                const descriptor = await LocalLlmSessionController.resolveDescriptor();

                await LocalLlmEngineClient.load(descriptor, (progressReport) =>
                {
                    if (typeof onProgress === "function")
                    {
                        onProgress(LocalLlmSessionController.#normaliseProgress(progressReport, descriptor));
                    }
                });

                LocalLlmSessionController.#activeDescriptor = descriptor;
                return descriptor;
            };

            try
            {
                return await loadOnce();
            }
            catch (loadError)
            {
                if (loadError?.name !== LocalLlmSessionController.DEVICE_LOST_ERROR_NAME)
                {
                    throw loadError;
                }

                // A GPU that hangs commonly does it here, uploading weights,
                // rather than later during generation. Same response as the
                // generate path: retire graphics for this machine, re-select,
                // and come back on the processor backend. Without this the
                // learner is simply told the download failed, on a device that
                // can run the model perfectly well on its processor.
                console.warn(`[LocalLlmSessionController] GPU device lost while loading — retiring the graphics backend on this device and reloading on the processor backend. (${loadError.message})`);
                await LocalLlmDeviceProbe.recordGraphicsUnusable(loadError.message);

                LocalLlmEngineClient.terminate();
                LocalLlmSessionController.#activeDescriptor = null;
                LocalLlmSessionController.#selectionOutcome = null;

                return await loadOnce();
            }
        })();

        // A failed load must not poison every later attempt — clearing the
        // memo lets the learner retry from the picker.
        LocalLlmSessionController.#readyPromise.catch(() =>
        {
            LocalLlmSessionController.#readyPromise = null;
        });

        return LocalLlmSessionController.#readyPromise;
    }

    /**
     * Runs the probe / manifest / selection chain without loading anything.
     * The picker and the capability state use this to know what the device
     * would get before a learner commits to a download.
     */
    static async resolveDescriptor()
    {
        const deviceProfile = await LocalLlmDeviceProbe.probe();
        await LocalLlmManifestClient.fetchDescriptors();

        const selectionOutcome = LocalLlmModelSelector.select(
            deviceProfile,
            LocalLlmManifestClient.getAvailableModelKeys(),
            LocalLlmDeviceProbe.getForcedModelKey()
        );
        LocalLlmSessionController.#selectionOutcome = selectionOutcome;

        if (!selectionOutcome.isAvailable())
        {
            throw new Error("No on-device model is available for this device.");
        }

        const descriptor = LocalLlmManifestClient.getDescriptor(selectionOutcome.getModelKey());
        if (!descriptor)
        {
            throw new Error(`The server no longer serves "${selectionOutcome.getModelKey()}".`);
        }

        return descriptor;
    }

    /**
     * Resolves the selection without throwing, for callers that want to
     * render a reason rather than handle an error. Returns the outcome
     * whether or not a model was found.
     */
    static async resolveSelectionOutcome()
    {
        const deviceProfile = await LocalLlmDeviceProbe.probe();
        await LocalLlmManifestClient.fetchDescriptors();

        LocalLlmSessionController.#selectionOutcome = LocalLlmModelSelector.select(
            deviceProfile,
            LocalLlmManifestClient.getAvailableModelKeys(),
            LocalLlmDeviceProbe.getForcedModelKey()
        );
        return LocalLlmSessionController.#selectionOutcome;
    }

    static getSelectionOutcome()
    {
        return LocalLlmSessionController.#selectionOutcome;
    }

    static getActiveDescriptor()
    {
        return LocalLlmSessionController.#activeDescriptor;
    }

    static isReady()
    {
        return LocalLlmSessionController.#activeDescriptor !== null && LocalLlmEngineClient.isEngineReady();
    }

    /**
     * Streams a completion from the loaded model, loading it first if needed.
     */
    /**
     * `onLoadProgress` is optional and matters more than it looks. A generate
     * that arrives before the model is on the device triggers the download
     * inside this call — up to ~1.8 GB for a processor model — and without a
     * way to report that, the caller shows a "Thinking…" placeholder for
     * several minutes and the feature reads as hung. Forwarded so the caller
     * can say what is actually happening.
     */
    static async generate(request, onToken, onLoadProgress = null)
    {
        try
        {
            await LocalLlmSessionController.ensureReady(onLoadProgress);
            return await LocalLlmEngineClient.generate(request, onToken);
        }
        catch (generationError)
        {
            if (generationError?.name !== LocalLlmSessionController.DEVICE_LOST_ERROR_NAME)
            {
                throw generationError;
            }

            // The GPU lost its device doing real work. An adapter can advertise
            // every limit the catalogue asks for and still hang the moment it
            // is driven — an integrated GPU past its watchdog timeout is the
            // common case, and no probe can see it coming. Retrying on the same
            // backend would reproduce it, so graphics is retired for this
            // machine and the selection redone: the processor models are slower
            // but they run, which is the whole point of the tier.
            //
            // Recorded before re-resolving, because the flag is exactly what
            // makes the probe report the hardware as graphics-incapable and the
            // selector therefore pick a processor model.
            console.warn(`[LocalLlmSessionController] GPU device lost — retiring the graphics backend on this device and retrying on the processor backend. (${generationError.message})`);
            await LocalLlmDeviceProbe.recordGraphicsUnusable(generationError.message);

            LocalLlmSessionController.release();
            LocalLlmSessionController.#selectionOutcome = null;

            // The retry is where the processor model gets downloaded, so the
            // progress callback matters most here.
            await LocalLlmSessionController.ensureReady(onLoadProgress);
            return await LocalLlmEngineClient.generate(request, onToken);
        }
    }

    static interrupt()
    {
        LocalLlmEngineClient.interrupt();
    }

    /**
     * Drops the engine and forgets the load. The next ensureReady() starts
     * over — already-fetched weights come back from the browser cache, so
     * this is cheap after a first successful download.
     */
    static release()
    {
        LocalLlmEngineClient.terminate();
        LocalLlmSessionController.#readyPromise = null;
        LocalLlmSessionController.#activeDescriptor = null;
    }

    /**
     * Turns an engine's progress report into the byte-denominated shape the
     * download UI expects. The graphics backend reports only a fraction, so
     * the manifest's real total is used to derive bytes; the processor
     * backend reports genuine bytes and is passed through.
     */
    static #normaliseProgress(progressReport, descriptor)
    {
        const totalBytes = progressReport.totalBytes > 0 ? progressReport.totalBytes : descriptor.totalBytes;
        const loadedBytes = progressReport.loadedBytes > 0
            ? progressReport.loadedBytes
            : Math.floor((progressReport.fraction || 0) * totalBytes);

        return {
            fraction: totalBytes > 0 ? Math.max(0, Math.min(1, loadedBytes / totalBytes)) : 0,
            loadedBytes: loadedBytes,
            totalBytes: totalBytes,
            statusText: progressReport.statusText || "",
        };
    }
}

export default LocalLlmSessionController;
