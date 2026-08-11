const fs = require("fs");
const path = require("path");
const LocalLlmModelCatalogue = require("../../Constants/LocalLlmModelCatalogue");
const LocalLlmDownloadConstants = require("../../Constants/LocalLlmDownloadConstants");


/**
 * LocalLlmModelRegistry
 *
 * Server-side view of which Free-tier models this deployment can actually
 * serve. It answers one question — "what is on disk, and is it complete?" —
 * by walking Dock/Assets/Models/<folderName>/ for every entry the catalogue
 * declares.
 *
 * Discovery is deliberate: the set of models is data
 * (Common/Constants/LocalLlmModelCatalogue.json), never code. Provisioning
 * a new model means adding a catalogue entry and dropping its folder in — no
 * server change, no redeploy of logic. An operator can also narrow what a
 * given environment offers with BROWSER_LLM_ENABLED_MODELS in Dock/.env
 * without deleting any files.
 *
 * A graphics model's `folderName` ends in "/resolve/main" on purpose, and the
 * files really do live there. Its engine rewrites any model URL that does not
 * already contain "/resolve/<something>/" by appending "resolve/main/",
 * assuming it was handed a HuggingFace repository root — so a self-hosted
 * mirror has to reproduce that path shape or every shard request 404s. Putting
 * it in the folder name rather than special-casing it here keeps the served
 * URL and the directory identical, and keeps adding a model a catalogue edit.
 *
 * Completeness matters more than presence. A half-copied model directory
 * loads happily for a few hundred megabytes and then fails inside WebLLM with
 * an opaque WebGPU error, so every entry in the descriptor's
 * `requiredFileNames` must exist and be non-empty, and — for the WebGPU
 * engine, whose weights are sharded — every shard named by the model's
 * ndarray-cache.json must exist too. Anything short of that is reported as
 * incomplete and never offered to a client.
 */
class LocalLlmModelRegistry
{
    static ENABLED_MODELS_ENVIRONMENT_VARIABLE = "BROWSER_LLM_ENABLED_MODELS";
    static MODELS_DIRECTORY_NAME = "Models";

    // Names that live inside a model directory for bookkeeping and must never
    // be advertised to a client as something to download.
    static EXCLUDED_FILE_NAME_PATTERN = /^\.|\.partial$/;

    static #cachedDescription = null;
    static #cachedSignature = null;

    /**
     * The catalogue keys this deployment is willing to serve. Unset or empty
     * means "every provisioned model"; an explicit list lets an operator hold
     * a model back (or reorder nothing — order is the catalogue's job) without
     * touching the files.
     */
    static getEnabledModelKeys()
    {
        const orderedKeys = Array.isArray(LocalLlmModelCatalogue.ORDER) ? LocalLlmModelCatalogue.ORDER : [];
        const configuredValue = String(process.env[LocalLlmModelRegistry.ENABLED_MODELS_ENVIRONMENT_VARIABLE] || "").trim();

        if (configuredValue.length === 0)
        {
            return orderedKeys;
        }

        const requestedKeys = configuredValue
            .split(",")
            .map((modelKey) => modelKey.trim())
            .filter((modelKey) => modelKey.length > 0);

        return orderedKeys.filter((modelKey) => requestedKeys.includes(modelKey));
    }

    /**
     * Walks a model directory and returns every servable file as a
     * forward-slash relative path plus its size. Pure apart from the file
     * system read, and recursive because the ONNX layout nests its weights
     * under an onnx/ subdirectory.
     */
    static collectFiles(rootDirectory)
    {
        const collectedFiles = [];

        const walk = (currentDirectory, relativePrefix) =>
        {
            let directoryEntries;
            try
            {
                directoryEntries = fs.readdirSync(currentDirectory, { withFileTypes: true });
            }
            catch (readError)
            {
                console.error(`[LocalLlmModelRegistry] Could not read ${currentDirectory}: ${readError.message}`);
                return;
            }

            for (const directoryEntry of directoryEntries)
            {
                const entryName = directoryEntry.name;
                if (LocalLlmModelRegistry.EXCLUDED_FILE_NAME_PATTERN.test(entryName))
                {
                    continue;
                }

                const absolutePath = path.join(currentDirectory, entryName);
                const relativePath = relativePrefix.length > 0 ? `${relativePrefix}/${entryName}` : entryName;

                // isDirectory()/isFile() are false for symlinks, so a link
                // planted inside the assets tree is skipped rather than
                // followed out of it.
                if (directoryEntry.isDirectory())
                {
                    walk(absolutePath, relativePath);
                    continue;
                }
                if (!directoryEntry.isFile())
                {
                    continue;
                }

                collectedFiles.push({ path: relativePath, sizeBytes: fs.statSync(absolutePath).size });
            }
        };

        walk(rootDirectory, "");
        return collectedFiles;
    }

    /**
     * True when every file the descriptor declares as required is present and
     * non-empty, and — when the descriptor names a shard manifest — every
     * shard that manifest lists is present too.
     */
    static isModelComplete(descriptor, collectedFiles, modelDirectory)
    {
        const presentPaths = new Map(collectedFiles.map((collectedFile) => [collectedFile.path, collectedFile.sizeBytes]));

        const requiredFileNames = Array.isArray(descriptor.requiredFileNames) ? descriptor.requiredFileNames : [];
        for (const requiredFileName of requiredFileNames)
        {
            const presentSize = presentPaths.get(requiredFileName);
            if (presentSize === undefined || presentSize === 0)
            {
                return false;
            }
        }

        if (!descriptor.shardManifestFileName)
        {
            return true;
        }

        const shardPaths = LocalLlmModelRegistry.readShardPaths(descriptor, modelDirectory);
        for (const shardPath of shardPaths)
        {
            const presentSize = presentPaths.get(shardPath);
            if (presentSize === undefined || presentSize === 0)
            {
                return false;
            }
        }

        return true;
    }

    /**
     * The shard file names a WebGPU model's ndarray-cache.json points at. The
     * count varies per model and changes when upstream re-shards, so it is
     * always read rather than assumed.
     */
    static readShardPaths(descriptor, modelDirectory)
    {
        const shardManifestPath = path.join(modelDirectory, descriptor.shardManifestFileName);
        if (!fs.existsSync(shardManifestPath))
        {
            return [];
        }

        try
        {
            const shardManifest = JSON.parse(fs.readFileSync(shardManifestPath, "utf8"));
            const records = Array.isArray(shardManifest.records) ? shardManifest.records : [];
            const shardPaths = new Set();

            for (const record of records)
            {
                if (record && typeof record.dataPath === "string" && record.dataPath.length > 0)
                {
                    shardPaths.add(record.dataPath);
                }
            }

            return Array.from(shardPaths);
        }
        catch (parseError)
        {
            console.error(`[LocalLlmModelRegistry] Malformed ${descriptor.shardManifestFileName} in ${modelDirectory}: ${parseError.message}`);
            return [];
        }
    }

    /**
     * Builds the client-facing description of every enabled model. Memoised on
     * the assets tree's modification signature — a model directory holds
     * dozens of files and this is walked on every download attempt.
     */
    static describeModels(assetsDirectory)
    {
        const modelsDirectory = path.join(assetsDirectory, LocalLlmModelRegistry.MODELS_DIRECTORY_NAME);
        const signature = LocalLlmModelRegistry.buildDirectorySignature(modelsDirectory);

        if (LocalLlmModelRegistry.#cachedDescription !== null && LocalLlmModelRegistry.#cachedSignature === signature)
        {
            return LocalLlmModelRegistry.#cachedDescription;
        }

        const describedModels = [];

        for (const modelKey of LocalLlmModelRegistry.getEnabledModelKeys())
        {
            const descriptor = LocalLlmModelCatalogue[modelKey];
            if (!descriptor)
            {
                console.error(`[LocalLlmModelRegistry] "${modelKey}" is in ORDER but absent from the catalogue body.`);
                continue;
            }

            const modelDirectory = path.join(modelsDirectory, ...descriptor.folderName.split("/"));
            if (!fs.existsSync(modelDirectory))
            {
                continue;
            }

            const collectedFiles = LocalLlmModelRegistry.collectFiles(modelDirectory);
            if (collectedFiles.length === 0)
            {
                continue;
            }

            const baseUrl = `${LocalLlmDownloadConstants.ASSETS_BASE_PATH}/${descriptor.folderName}/`;
            const servableFiles = [];
            let totalByteCount = 0;
            let modelLibraryUrl = null;

            for (const collectedFile of collectedFiles)
            {
                totalByteCount += collectedFile.sizeBytes;

                // The engine binary is separated out so the client's WebLLM
                // appConfig can point model_lib straight at it.
                if (descriptor.modelLibraryFileName && collectedFile.path === descriptor.modelLibraryFileName)
                {
                    modelLibraryUrl = `${baseUrl}${collectedFile.path}`;
                    continue;
                }

                servableFiles.push(collectedFile);
            }

            describedModels.push(
            {
                modelKey: modelKey,
                executionBackend: descriptor.executionBackend,
                engineModelId: descriptor.engineModelId,
                baseUrl: baseUrl,
                modelLibraryUrl: modelLibraryUrl,
                onnxDataType: descriptor.onnxDataType,
                contextWindowTokens: descriptor.contextWindowTokens,
                files: servableFiles,
                totalBytes: totalByteCount,
                bComplete: LocalLlmModelRegistry.isModelComplete(descriptor, collectedFiles, modelDirectory),
            });
        }

        LocalLlmModelRegistry.#cachedDescription = describedModels;
        LocalLlmModelRegistry.#cachedSignature = signature;
        return describedModels;
    }

    /**
     * A cheap fingerprint of the models tree: the modification time of the
     * tree root plus that of each model's own directory. Provisioning writes
     * into a model directory, which moves its mtime, so a newly-completed
     * model is picked up without a restart.
     */
    static buildDirectorySignature(modelsDirectory)
    {
        if (!fs.existsSync(modelsDirectory))
        {
            return "absent";
        }

        const signatureParts = [];

        const visit = (currentDirectory, depth) =>
        {
            try
            {
                signatureParts.push(`${currentDirectory}:${fs.statSync(currentDirectory).mtimeMs}`);
                if (depth === 0)
                {
                    return;
                }
                for (const directoryEntry of fs.readdirSync(currentDirectory, { withFileTypes: true }))
                {
                    if (directoryEntry.isDirectory())
                    {
                        visit(path.join(currentDirectory, directoryEntry.name), depth - 1);
                    }
                }
            }
            catch (statError)
            {
                signatureParts.push(`${currentDirectory}:unreadable`);
            }
        };

        // Depth 4 covers the deepest layout any catalogue entry uses today —
        // "<model>/resolve/main/" for the graphics models, which mirror the
        // HuggingFace path shape their engine insists on (see the folderName
        // note in Dock/Assets/Models/README.txt) — with a level spare so a
        // model whose files sit one directory lower still moves the signature
        // when it is provisioned.
        visit(modelsDirectory, 4);
        return signatureParts.join("|");
    }

    static resetCache()
    {
        LocalLlmModelRegistry.#cachedDescription = null;
        LocalLlmModelRegistry.#cachedSignature = null;
    }
}

module.exports = LocalLlmModelRegistry;
