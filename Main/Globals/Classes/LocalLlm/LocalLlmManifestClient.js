import LocalLlmDownloadConstants from "../../Constants/LocalLlmDownloadConstants.js";
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

            try
            {
                const manifestResponse = await fetch(LocalLlmDownloadConstants.MANIFEST_ENDPOINT_PATH,
                {
                    method: "GET",
                    credentials: "include",
                });

                if (manifestResponse.status === 503)
                {
                    LocalLlmManifestClient.#bLastFetchFailed = false;
                    LocalLlmManifestClient.#descriptorsByModelKey = descriptorsByModelKey;
                    return descriptorsByModelKey;
                }
                if (!manifestResponse.ok)
                {
                    throw new Error(`server returned ${manifestResponse.status}`);
                }

                const manifest = await manifestResponse.json();
                LocalLlmManifestClient.#runtimeBaseUrl = typeof manifest?.runtimeBaseUrl === "string"
                    ? manifest.runtimeBaseUrl
                    : LocalLlmDownloadConstants.RUNTIME_ASSETS_BASE_PATH;

                for (const servedModel of Array.isArray(manifest?.models) ? manifest.models : [])
                {
                    const mergedDescriptor = LocalLlmManifestClient.#mergeWithCatalogue(servedModel);
                    if (mergedDescriptor)
                    {
                        descriptorsByModelKey.set(mergedDescriptor.modelKey, mergedDescriptor);
                    }
                }

                LocalLlmManifestClient.#bLastFetchFailed = false;
            }
            catch (fetchError)
            {
                // Offline is the expected case here, and it is not fatal: a
                // model already in the Cache API still runs. The caller
                // distinguishes "server says nothing is provisioned" from
                // "could not ask" via didLastFetchFail().
                console.warn(`[LocalLlmManifestClient] Could not read the model manifest: ${fetchError?.message || fetchError}`);
                LocalLlmManifestClient.#bLastFetchFailed = true;
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
}

export default LocalLlmManifestClient;
