import LocalLlmDeviceProbe from "./LocalLlmDeviceProbe.js";
import PreferredLocalLlmModel from "./PreferredLocalLlmModel.js";
import LocalLlmDriverFactory from "./Drivers/LocalLlmDriverFactory.js";
import LocalLlmManifestClient from "./LocalLlmManifestClient.js";
import LocalLlmModelSelector from "./LocalLlmModelSelector.js";


/**
 * LocalLlmSessionController
 *
 * The single front door to the on-device model. Everything else — the
 * download manager, the Ask AI runner, deck chat — goes through
 * `ensureReady()` and never touches the probe, the manifest or a driver
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
 *
 * WHICH ENGINE ACTUALLY RUNS IS NOT DECIDED HERE. The selected model declares
 * its own execution backend and LocalLlmDriverFactory returns the driver for
 * it, so this class never branches on graphics-versus-native. That is what
 * keeps the surface below it — Ask AI, deck chat, the picker — unable to tell
 * the difference, and what lets a third execution path arrive without this
 * file changing at all.
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
    static #activeDriver = null;

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
                const driver = LocalLlmSessionController.#resolveDriver(descriptor);

                await driver.load(descriptor, (progressReport) =>
                {
                    if (typeof onProgress === "function")
                    {
                        onProgress(LocalLlmSessionController.#normaliseProgress(progressReport, descriptor));
                    }
                });

                LocalLlmSessionController.#activeDescriptor = descriptor;
                LocalLlmSessionController.#activeDriver = driver;
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
                // and come back on whatever the selector offers next — a
                // smaller graphics model, or the native runtime where the app
                // provides one. Without this the learner is simply told the
                // download failed, on a device that can run a model perfectly
                // well by another route.
                console.warn(`[LocalLlmSessionController] GPU device lost while loading — retiring the graphics backend on this device and re-selecting. (${loadError.message})`);
                await LocalLlmDeviceProbe.recordGraphicsUnusable(loadError.message);

                LocalLlmSessionController.#releaseActiveDriver();
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
     * Fetches ONE named model's weights onto the device, whatever is selected.
     *
     * Separate from ensureReady because the two answer different questions.
     * ensureReady means "make the tier usable" and is about the selected
     * model; this means "get me these bytes" and is about a model the learner
     * pointed at in a list — possibly one they are not switching to. Routing
     * the second through the first would make every download a selection
     * change, which is precisely the coupling that made switching models feel
     * like a commitment.
     *
     * It deliberately does NOT touch #readyPromise or #activeDescriptor. On
     * the graphics backend the download does happen to leave its model in the
     * engine, but recording that here would tell the rest of the app the tier
     * had switched models on its own.
     */
    static async downloadModel(descriptor, onProgress = null)
    {
        const driver = LocalLlmSessionController.#resolveDriver(descriptor);

        await driver.download(descriptor, (progressReport) =>
        {
            if (typeof onProgress === "function")
            {
                onProgress(LocalLlmSessionController.#normaliseProgress(progressReport, descriptor));
            }
        });
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
        await PreferredLocalLlmModel.hydrate();

        const selectionOutcome = LocalLlmModelSelector.select(
            deviceProfile,
            LocalLlmManifestClient.getAvailableModelKeys(),
            LocalLlmDeviceProbe.getForcedModelKey(),
            PreferredLocalLlmModel.getModelKey()
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
        await PreferredLocalLlmModel.hydrate();

        LocalLlmSessionController.#selectionOutcome = LocalLlmModelSelector.select(
            deviceProfile,
            LocalLlmManifestClient.getAvailableModelKeys(),
            LocalLlmDeviceProbe.getForcedModelKey(),
            PreferredLocalLlmModel.getModelKey()
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
        return LocalLlmSessionController.#activeDescriptor !== null
            && LocalLlmSessionController.#activeDriver !== null
            && LocalLlmSessionController.#activeDriver.isReady();
    }

    /**
     * The driver the selected model requires, or a thrown explanation.
     *
     * Throwing rather than silently falling back to another driver is
     * deliberate. A descriptor arriving with a backend nothing implements means
     * the server is offering a model this build cannot run — a provisioning or
     * version mismatch — and running it on the wrong engine would fail much
     * later, inside a worker or across a command boundary, with a message that
     * says nothing about the real cause.
     */
    static #resolveDriver(descriptor)
    {
        const driver = LocalLlmDriverFactory.resolveForDescriptor(descriptor);

        if (driver === null)
        {
            throw new Error(`No on-device engine in this build can run "${descriptor.modelKey}" (${descriptor.executionBackend}).`);
        }
        return driver;
    }

    static #releaseActiveDriver()
    {
        if (LocalLlmSessionController.#activeDriver !== null)
        {
            LocalLlmSessionController.#activeDriver.unload();
            LocalLlmSessionController.#activeDriver = null;
        }
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
            return await LocalLlmSessionController.#activeDriver.generate(request, onToken);
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
            // machine and the selection redone: whatever the selector offers
            // next runs, which is the whole point of the tier.
            //
            // Recorded before re-resolving, because the flag is exactly what
            // makes the probe report the hardware as graphics-incapable and the
            // selector therefore pick something else.
            console.warn(`[LocalLlmSessionController] GPU device lost — retiring the graphics backend on this device and retrying. (${generationError.message})`);
            await LocalLlmDeviceProbe.recordGraphicsUnusable(generationError.message);

            LocalLlmSessionController.release();
            LocalLlmSessionController.#selectionOutcome = null;

            // The retry is where the replacement model gets downloaded, so the
            // progress callback matters most here.
            await LocalLlmSessionController.ensureReady(onLoadProgress);
            return await LocalLlmSessionController.#activeDriver.generate(request, onToken);
        }
    }

    static interrupt()
    {
        if (LocalLlmSessionController.#activeDriver !== null)
        {
            LocalLlmSessionController.#activeDriver.interrupt();
        }
    }

    /**
     * Drops the engine and forgets the load. The next ensureReady() starts
     * over — already-fetched weights come back from wherever the driver put
     * them (the browser's own store, or the app's data directory), so this is
     * cheap after a first successful download.
     */
    static release()
    {
        LocalLlmSessionController.#releaseActiveDriver();
        LocalLlmSessionController.#readyPromise = null;
        LocalLlmSessionController.#activeDescriptor = null;
    }

    /**
     * Turns a driver's progress report into the byte-denominated shape the
     * download UI expects. The graphics backend reports only a fraction, so
     * the manifest's real total is used to derive bytes; drivers that report
     * genuine bytes are passed through.
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
