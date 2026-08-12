import LocalLlmDownloadConstants from "../../Constants/LocalLlmDownloadConstants.js";
import Persistence from "../Persistence.js";
import { dataFormats } from "../../Enumerations/DataFormats.js";
import LocalLlmModelSelector from "./LocalLlmModelSelector.js";


/**
 * LocalLlmManifestClient
 *
 * Asks the server which Free-tier models it has provisioned, and joins each
 * answer to its catalogue descriptor so the rest of the app has one object
 * carrying both the served URLs and the declared device requirements.
 *
 * Fetched once per page load. The answer changes only when an operator
 * provisions a model, which is not something that happens mid-session, and
 * the alternative — re-asking on every mount of the tier picker, which
 * appears on four surfaces — would be pure noise.
 *
 * A 503 is a normal answer, not an error: it means this deployment has not
 * provisioned any model yet. It resolves to an empty set, and the selector
 * turns that into an honest "not available on this server" rather than a
 * failed download.
 */
class LocalLlmManifestClient
{
    static #descriptorsByModelKey = null;
    static #runtimeBaseUrl = null;
    static #fetchPromise = null;
    static #bLastFetchFailed = false;

    /**
     * Resolves to a Map of modelKey to a merged descriptor. Empty when the
     * server has nothing provisioned or could not be reached.
     */
    static fetchDescriptors()
    {
        if (LocalLlmManifestClient.#fetchPromise)
        {
            return LocalLlmManifestClient.#fetchPromise;
        }

        LocalLlmManifestClient.#fetchPromise = (async () =>
        {
            const descriptorsByModelKey = new Map();

            // ONLY a genuine network failure may fall back to the recorded
            // manifest. If the server ANSWERED — 401, 403, 500, anything — its
            // answer is the truth about what it serves, and replaying an older
            // one puts words in its mouth.
            //
            // That distinction is not academic. A 401 during boot, before the
            // session has settled, used to land in the catch below and replay a
            // manifest recorded against a DIFFERENT server. The client was then
            // offered a model this origin had never heard of and every download
            // answered 404 — which reads as a broken server rather than as a
            // stale cache, and sent the search in entirely the wrong direction.
            let manifestResponse = null;
            let networkFailure = null;

            try
            {
                manifestResponse = await fetch(LocalLlmDownloadConstants.MANIFEST_ENDPOINT_PATH,
                {
                    method: "GET",
                    credentials: "include",
                });
            }
            catch (unreachableError)
            {
                networkFailure = unreachableError;
            }

            if (manifestResponse !== null)
            {
                // 503 is a normal answer: this deployment has provisioned
                // nothing. So is 401 — the session is not ready, and it will be
                // asked again. Both are authoritative and empty.
                if (!manifestResponse.ok)
                {
                    if (manifestResponse.status !== 503)
                    {
                        console.warn(`[LocalLlmManifestClient] The server answered ${manifestResponse.status} for the model manifest; taking that as "no models from here" rather than replaying an older one.`);
                    }
                    LocalLlmManifestClient.#bLastFetchFailed = false;
                    LocalLlmManifestClient.#descriptorsByModelKey = descriptorsByModelKey;
                    return descriptorsByModelKey;
                }

                const manifest = await manifestResponse.json();
                LocalLlmManifestClient.#runtimeBaseUrl = typeof manifest?.runtimeBaseUrl === "string"
                    ? manifest.runtimeBaseUrl
                    : LocalLlmDownloadConstants.RUNTIME_ASSETS_BASE_PATH;

                const servedModels = Array.isArray(manifest?.models) ? manifest.models : [];
                for (const servedModel of servedModels)
                {
                    const mergedDescriptor = LocalLlmManifestClient.#mergeWithCatalogue(servedModel);
                    if (mergedDescriptor)
                    {
                        descriptorsByModelKey.set(mergedDescriptor.modelKey, mergedDescriptor);
                    }
                }

                LocalLlmManifestClient.#bLastFetchFailed = false;
                await LocalLlmManifestClient.#persistManifest(servedModels, LocalLlmManifestClient.#runtimeBaseUrl);
            }
            else
            {
                // Genuinely unreachable. Offline must not be fatal — the whole
                // premise of this tier is a model that runs without a request —
                // but the descriptor names the model, its context window and its
                // files, and it only ever came from the server. Without it the
                // selector sees an empty catalogue and calls the tier
                // unavailable on a device whose weights are sitting on disk.
                //
                // The recorded manifest can name a model the server has since
                // withdrawn. That is the right trade: what makes it usable is
                // the weights already being present, and a withdrawn model the
                // device still holds is one it can still run.
                console.warn(`[LocalLlmManifestClient] Could not reach the server for the model manifest: ${networkFailure?.message || networkFailure}`);
                LocalLlmManifestClient.#bLastFetchFailed = true;

                const restoredModels = await LocalLlmManifestClient.#restorePersistedManifest();
                for (const restoredModel of restoredModels)
                {
                    const mergedDescriptor = LocalLlmManifestClient.#mergeWithCatalogue(restoredModel);
                    if (mergedDescriptor)
                    {
                        descriptorsByModelKey.set(mergedDescriptor.modelKey, mergedDescriptor);
                    }
                }

                if (descriptorsByModelKey.size > 0)
                {
                    console.log(`[LocalLlmManifestClient] Replayed ${descriptorsByModelKey.size} model(s) from the last manifest this device saw, so an already-downloaded model still runs offline.`);
                }
            }

            LocalLlmManifestClient.#descriptorsByModelKey = descriptorsByModelKey;
            return descriptorsByModelKey;
        })();

        return LocalLlmManifestClient.#fetchPromise;
    }

    /**
     * Joins what the server serves to what the catalogue declares. A served
     * model with no catalogue entry is dropped — the client would not know
     * what device it needs, so offering it could only produce a failed load.
     */
    static #mergeWithCatalogue(servedModel)
    {
        const modelKey = servedModel?.modelKey;
        const catalogueDescriptor = LocalLlmModelSelector.getDescriptor(modelKey);

        if (!catalogueDescriptor)
        {
            console.warn(`[LocalLlmManifestClient] Server offers "${modelKey}", which this build's catalogue does not declare — ignoring it.`);
            return null;
        }

        return {
            modelKey: modelKey,
            executionBackend: catalogueDescriptor.executionBackend,
            engineModelId: catalogueDescriptor.engineModelId,
            displayName: catalogueDescriptor.displayName,
            parameterLabel: catalogueDescriptor.parameterLabel,
            displayNote: catalogueDescriptor.displayNote,
            vramRequiredMegabytes: catalogueDescriptor.vramRequiredMegabytes,
            contextWindowTokens: servedModel.contextWindowTokens || catalogueDescriptor.contextWindowTokens,
            onnxDataType: catalogueDescriptor.onnxDataType,
            baseUrl: servedModel.baseUrl,
            modelLibraryUrl: servedModel.modelLibraryUrl,
            localModelPath: LocalLlmDownloadConstants.ASSETS_BASE_PATH,

            // What the native runtime needs to fetch and load the weights.
            // Null for every browser model, and carried for all backends so the
            // descriptor keeps ONE shape — a consumer that branches on which
            // keys exist breaks the first time a model type is added.
            //
            // Easy to omit, and silent when omitted: this function builds a new
            // object from a fixed list rather than spreading the source, so a
            // field that is not named here simply does not exist downstream.
            // NativeRuntimeDriver would then ask the native side to download
            // "undefined", which fails as a bad URL rather than as a missing
            // field, several layers from the cause.
            weightsUrl: servedModel.weightsUrl || null,
            weightsFileName: servedModel.weightsFileName || catalogueDescriptor.weightsFileName || null,
            quantisationLabel: servedModel.quantisationLabel || catalogueDescriptor.quantisationLabel || null,
            recommendedThreadCount: Number.isFinite(servedModel.recommendedThreadCount)
                ? servedModel.recommendedThreadCount
                : (catalogueDescriptor.recommendedThreadCount || 0),
            sha256: catalogueDescriptor.sha256 || null,
            runtimeBaseUrl: LocalLlmManifestClient.#runtimeBaseUrl || LocalLlmDownloadConstants.RUNTIME_ASSETS_BASE_PATH,
            // The server's real byte count beats the catalogue's estimate for
            // the progress bar; the estimate survives only as a fallback.
            totalBytes: Number.isFinite(servedModel.totalBytes) && servedModel.totalBytes > 0
                ? servedModel.totalBytes
                : catalogueDescriptor.approximateTotalBytes,
            approximateTotalLabel: catalogueDescriptor.approximateTotalLabel,
        };
    }

    static getCachedDescriptors()
    {
        return LocalLlmManifestClient.#descriptorsByModelKey;
    }

    static getDescriptor(modelKey)
    {
        const descriptorsByModelKey = LocalLlmManifestClient.#descriptorsByModelKey;
        return descriptorsByModelKey ? descriptorsByModelKey.get(modelKey) || null : null;
    }

    static getAvailableModelKeys()
    {
        const descriptorsByModelKey = LocalLlmManifestClient.#descriptorsByModelKey;
        return descriptorsByModelKey ? Array.from(descriptorsByModelKey.keys()) : [];
    }

    /**
     * True when the last attempt could not reach the server at all, as
     * opposed to reaching it and being told nothing is provisioned.
     */
    static didLastFetchFail()
    {
        return LocalLlmManifestClient.#bLastFetchFailed;
    }

    /**
     * Drops the memoised answer so the next call asks again. Used after a
     * provisioning change and by the tests.
     */
    static reset()
    {
        LocalLlmManifestClient.#descriptorsByModelKey = null;
        LocalLlmManifestClient.#runtimeBaseUrl = null;
        LocalLlmManifestClient.#fetchPromise = null;
        LocalLlmManifestClient.#bLastFetchFailed = false;
    }

    /**
     * Records the manifest so a later offline start can replay it.
     *
     * The SERVED entries are stored, not the merged descriptors, so a catalogue
     * change still applies on the way back out — a model whose context window
     * or requirements were corrected gets the corrected values, not the ones
     * that happened to be current when it was last online.
     *
     * Best-effort throughout. A device that cannot write this still works
     * exactly as it did before; it simply loses the offline replay.
     */
    static #currentOrigin()
    {
        return typeof window !== "undefined" && window.location ? window.location.origin : "";
    }

    static async #persistManifest(servedModels, runtimeBaseUrl)
    {
        if (!Array.isArray(servedModels) || servedModels.length === 0)
        {
            return;
        }

        try
        {
            await Persistence.write(
                LocalLlmDownloadConstants.LOCAL_MANIFEST_CACHE_PERSISTENCE_KEY,
                {
                    // Stamped with the server it came from. The record lives in
                    // the app's data directory, which is keyed to the bundle
                    // identifier and NOT to the URL the app happens to point at
                    // — so a build aimed at a developer's machine and a build
                    // aimed at production share one file. Without this stamp,
                    // the manifest from one is replayed against the other, and
                    // the client is offered models that origin never had.
                    origin: LocalLlmManifestClient.#currentOrigin(),
                    models: servedModels,
                    runtimeBaseUrl: runtimeBaseUrl,
                    at: Date.now(),
                },
                dataFormats.JSON
            );
        }
        catch (writeError)
        {
            console.warn(`[LocalLlmManifestClient] Could not record the manifest for offline use: ${writeError?.message || writeError}`);
        }
    }

    static async #restorePersistedManifest()
    {
        try
        {
            const bExists = await Persistence.exists(LocalLlmDownloadConstants.LOCAL_MANIFEST_CACHE_PERSISTENCE_KEY);
            if (!bExists)
            {
                return [];
            }

            const record = await Persistence.read(
                LocalLlmDownloadConstants.LOCAL_MANIFEST_CACHE_PERSISTENCE_KEY,
                dataFormats.JSON
            );

            const recordedOrigin = record ? record.origin : null;
            if (recordedOrigin && recordedOrigin !== LocalLlmManifestClient.#currentOrigin())
            {
                console.warn(`[LocalLlmManifestClient] The recorded manifest came from ${recordedOrigin} and this app talks to ${LocalLlmManifestClient.#currentOrigin()} — ignoring it rather than offering models this server may not have.`);
                return [];
            }

            if (record && typeof record.runtimeBaseUrl === "string")
            {
                LocalLlmManifestClient.#runtimeBaseUrl = record.runtimeBaseUrl;
            }
            return record && Array.isArray(record.models) ? record.models : [];
        }
        catch (readError)
        {
            console.warn(`[LocalLlmManifestClient] Could not replay the recorded manifest: ${readError?.message || readError}`);
            return [];
        }
    }
}

export default LocalLlmManifestClient;
