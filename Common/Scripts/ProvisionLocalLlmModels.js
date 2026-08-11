const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

/**
 * ProvisionLocalLlmModels
 *
 * Downloads the self-hosted weights for the Free-tier in-browser LLM into
 * Dock/Assets/ so the browser never has to reach a third-party CDN at run
 * time. The weights are several gigabytes and are therefore NOT in git —
 * this script is how a workstation or a deployed node obtains them.
 *
 * Everything it knows about a model comes from
 * Common/Constants/LocalLlmModelCatalogue.json, which it reads directly
 * (not the generated per-service mirror) so it runs before any build step.
 * Adding a model to the catalogue is enough to make it provisionable — no
 * change is needed here.
 *
 * Usage:
 *
 *     node Common/Scripts/ProvisionLocalLlmModels.js --list
 *     node Common/Scripts/ProvisionLocalLlmModels.js
 *     node Common/Scripts/ProvisionLocalLlmModels.js --models=QWEN2_5_1_5B_WEBGPU_Q4F16
 *     node Common/Scripts/ProvisionLocalLlmModels.js --verify-only
 *
 * Options:
 *     --models=<KEY,KEY>   Restrict to these catalogue keys (default: every key in ORDER).
 *     --destination=<dir>  Assets root to populate (default: Dock/Assets).
 *     --force              Re-download files that already verify.
 *     --verify-only        Re-check what is on disk; download nothing.
 *     --concurrency=<n>    Parallel transfers (default 4).
 *     --list               Print the catalogue with sizes and on-disk status, then exit.
 *
 * Integrity: HuggingFace's tree API reports an LFS sha256 for every large
 * file. Each download lands as "<name>.partial" and is renamed only once its
 * hash (or, for small non-LFS files, its byte length) matches. An interrupted
 * run therefore can never leave a corrupt shard behind — which matters
 * because a corrupt shard surfaces inside WebLLM as an opaque WebGPU error
 * hundreds of megabytes into a load.
 */
class LocalLlmModelProvisioner
{
    static HUGGING_FACE_ORIGIN = 'https://huggingface.co';
    static PROVISION_MANIFEST_FILE_NAME = '.provision-manifest.json';
    static PARTIAL_FILE_SUFFIX = '.partial';

    // The ONNX Runtime WebAssembly binary the vendored LocalLlm.js bundle
    // asks for. The bundle inlines every line of JavaScript but deliberately
    // leaves this binary out, and its built-in default points at a CDN — so
    // it has to be hosted alongside the models for the CPU backend to run
    // without a third-party request.
    static ONNX_RUNTIME_SOURCE_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.0/dist/';
    static ONNX_RUNTIME_FILE_NAMES = ['ort-wasm-simd-threaded.jsep.wasm'];
    static ONNX_RUNTIME_DIRECTORY_SEGMENTS = ['Runtime', 'OnnxRuntime'];

    // Repository files that are never needed by either engine.
    static IGNORED_REPOSITORY_FILE_NAMES = new Set(['.gitattributes', 'README.md', '.gitignore']);

    static DEFAULT_CONCURRENCY = 4;
    static MAXIMUM_ATTEMPTS_PER_FILE = 4;
    static RETRY_BASE_DELAY_MILLISECONDS = 1500;

    constructor(options)
    {
        this.repositoryRoot = options.repositoryRoot;
        this.destinationRoot = options.destinationRoot;
        this.requestedModelKeys = options.requestedModelKeys;
        this.bForce = options.bForce;
        this.bVerifyOnly = options.bVerifyOnly;
        this.concurrency = options.concurrency;

        this.catalogue = LocalLlmModelProvisioner.readCatalogue(options.repositoryRoot);
    }

    static readCatalogue(repositoryRoot)
    {
        const cataloguePath = path.join(repositoryRoot, 'Common', 'Constants', 'LocalLlmModelCatalogue.json');
        if (!fs.existsSync(cataloguePath))
        {
            throw new Error(`Model catalogue not found at ${cataloguePath}`);
        }
        return JSON.parse(fs.readFileSync(cataloguePath, 'utf8'));
    }

    getOrderedModelKeys()
    {
        const orderedKeys = Array.isArray(this.catalogue.ORDER) ? this.catalogue.ORDER : [];
        if (this.requestedModelKeys.length === 0)
        {
            return orderedKeys;
        }

        for (const requestedKey of this.requestedModelKeys)
        {
            if (!orderedKeys.includes(requestedKey))
            {
                throw new Error(`Unknown model key "${requestedKey}". Known keys: ${orderedKeys.join(', ')}`);
            }
        }
        return orderedKeys.filter((modelKey) => this.requestedModelKeys.includes(modelKey));
    }

    getModelDirectory(descriptor)
    {
        return path.join(this.destinationRoot, 'Models', ...descriptor.folderName.split('/'));
    }

    getOnnxRuntimeDirectory()
    {
        return path.join(this.destinationRoot, ...LocalLlmModelProvisioner.ONNX_RUNTIME_DIRECTORY_SEGMENTS);
    }

    async run()
    {
        const modelKeys = this.getOrderedModelKeys();
        if (modelKeys.length === 0)
        {
            console.error('No models selected — the catalogue ORDER array is empty.');
            process.exitCode = 1;
            return;
        }

        console.log(`Destination: ${this.destinationRoot}`);
        console.log(`Models: ${modelKeys.join(', ')}`);
        console.log(this.bVerifyOnly ? 'Mode: verify only (no downloads)\n' : '');

        let bAnyFailure = false;
        let bAnyWasmBackend = false;

        for (const modelKey of modelKeys)
        {
            const descriptor = this.catalogue[modelKey];
            if (!descriptor)
            {
                console.error(`  ${modelKey}: missing from the catalogue body despite being listed in ORDER.`);
                bAnyFailure = true;
                continue;
            }

            if (descriptor.executionBackend === 'WASM')
            {
                bAnyWasmBackend = true;
            }

            try
            {
                await this.provisionModel(modelKey, descriptor);
            }
            catch (provisionError)
            {
                console.error(`  ${modelKey}: FAILED — ${provisionError.message}`);
                bAnyFailure = true;
            }
        }

        if (bAnyWasmBackend)
        {
            try
            {
                await this.provisionOnnxRuntime();
            }
            catch (runtimeError)
            {
                console.error(`  ONNX Runtime: FAILED — ${runtimeError.message}`);
                bAnyFailure = true;
            }
        }

        if (bAnyFailure)
        {
            console.error('\nOne or more models could not be provisioned.');
            process.exitCode = 1;
            return;
        }

        console.log('\nAll selected models are provisioned and verified.');
    }

    async provisionModel(modelKey, descriptor)
    {
        console.log(`\n${modelKey} — ${descriptor.displayName}`);

        const modelDirectory = this.getModelDirectory(descriptor);
        const plannedFiles = await this.planFiles(descriptor);

        if (plannedFiles.length === 0)
        {
            throw new Error('resolved an empty file list from the source repository');
        }

        const plannedTotalBytes = plannedFiles.reduce((runningTotal, plannedFile) => runningTotal + plannedFile.sizeBytes, 0);
        console.log(`  ${plannedFiles.length} file(s), ${LocalLlmModelProvisioner.formatBytes(plannedTotalBytes)}`);

        if (!this.bVerifyOnly)
        {
            fs.mkdirSync(modelDirectory, { recursive: true });
        }

        const outcomes = await this.processFilesWithConcurrency(plannedFiles, modelDirectory);

        const missingOutcomes = outcomes.filter((outcome) => outcome.status === 'missing');
        if (missingOutcomes.length > 0)
        {
            throw new Error(`${missingOutcomes.length} file(s) absent or unverified — re-run without --verify-only`);
        }

        this.assertRequiredFilesPresent(descriptor, modelDirectory);

        if (!this.bVerifyOnly)
        {
            this.writeProvisionManifest(modelKey, descriptor, modelDirectory, outcomes);
        }

        this.reportMeasuredBufferRequirement(descriptor, modelDirectory);

        const downloadedCount = outcomes.filter((outcome) => outcome.status === 'downloaded').length;
        const skippedCount = outcomes.filter((outcome) => outcome.status === 'verified').length;
        console.log(`  OK — ${downloadedCount} downloaded, ${skippedCount} already present and verified`);
    }

    /**
     * Resolves the exact file list for a model from its source repository.
     * WebGPU (MLC) repositories are taken wholesale minus the documentation
     * files, because the shard count varies per model and hardcoding it
     * would silently under-provision after an upstream re-shard. WASM (ONNX)
     * repositories carry every quantization variant, so only the one this
     * catalogue entry names is pulled.
     */
    async planFiles(descriptor)
    {
        const repositoryEntries = await this.fetchRepositoryTree(descriptor.sourceRepository);
        const plannedFiles = [];

        if (descriptor.executionBackend === 'NATIVE_RUNTIME')
        {
            // Exactly one file, named by the catalogue. A GGUF is
            // self-contained — weights, tokeniser and metadata in one
            // container — so nothing else in the repository is needed, and the
            // fallback below would be actively harmful here: these repositories
            // publish every quantisation side by side, so taking "all files"
            // would pull eight variants of the same model and tens of
            // gigabytes to use one of them.
            const weightsEntry = repositoryEntries.find(
                (repositoryEntry) => repositoryEntry.path === descriptor.weightsFileName);

            if (!weightsEntry)
            {
                throw new Error(`${descriptor.sourceRepository} has no ${descriptor.weightsFileName} — check weightsFileName in the catalogue`);
            }

            plannedFiles.push(LocalLlmModelProvisioner.toPlannedFile(descriptor, weightsEntry));
            return plannedFiles;
        }

        if (descriptor.executionBackend === 'WASM')
        {
            const onnxFileName = `onnx/model_${descriptor.onnxDataType}.onnx`;
            const onnxDataFileName = `${onnxFileName}_data`;

            for (const repositoryEntry of repositoryEntries)
            {
                const bIsRootMetadataFile = !repositoryEntry.path.includes('/')
                    && !LocalLlmModelProvisioner.IGNORED_REPOSITORY_FILE_NAMES.has(repositoryEntry.path);
                const bIsSelectedOnnxFile = repositoryEntry.path === onnxFileName
                    || repositoryEntry.path === onnxDataFileName;

                if (bIsRootMetadataFile || bIsSelectedOnnxFile)
                {
                    plannedFiles.push(LocalLlmModelProvisioner.toPlannedFile(descriptor, repositoryEntry));
                }
            }

            if (!plannedFiles.some((plannedFile) => plannedFile.relativePath === onnxFileName))
            {
                throw new Error(`${descriptor.sourceRepository} has no ${onnxFileName} — check onnxDataType in the catalogue`);
            }

            return plannedFiles;
        }

        for (const repositoryEntry of repositoryEntries)
        {
            if (LocalLlmModelProvisioner.IGNORED_REPOSITORY_FILE_NAMES.has(repositoryEntry.path))
            {
                continue;
            }
            plannedFiles.push(LocalLlmModelProvisioner.toPlannedFile(descriptor, repositoryEntry));
        }

        if (descriptor.modelLibraryFileName)
        {
            plannedFiles.push(
            {
                relativePath: descriptor.modelLibraryFileName,
                sourceUrl: `${descriptor.modelLibrarySourceUrl}${descriptor.modelLibraryFileName}`,
                sizeBytes: 0,
                expectedSha256: null,
            });
        }

        return plannedFiles;
    }

    static toPlannedFile(descriptor, repositoryEntry)
    {
        const lfsRecord = repositoryEntry.lfs || null;
        return {
            relativePath: repositoryEntry.path,
            sourceUrl: `${LocalLlmModelProvisioner.HUGGING_FACE_ORIGIN}/${descriptor.sourceRepository}/resolve/main/${repositoryEntry.path}`,
            sizeBytes: lfsRecord && typeof lfsRecord.size === 'number' ? lfsRecord.size : (repositoryEntry.size || 0),
            expectedSha256: lfsRecord && typeof lfsRecord.oid === 'string' ? lfsRecord.oid : null,
        };
    }

    async fetchRepositoryTree(sourceRepository)
    {
        const treeUrl = `${LocalLlmModelProvisioner.HUGGING_FACE_ORIGIN}/api/models/${sourceRepository}/tree/main?recursive=1`;
        const response = await fetch(treeUrl);
        if (!response.ok)
        {
            throw new Error(`could not list ${sourceRepository} (HTTP ${response.status})`);
        }

        const treeEntries = await response.json();
        if (!Array.isArray(treeEntries))
        {
            throw new Error(`unexpected tree listing for ${sourceRepository}`);
        }

        return treeEntries.filter((treeEntry) => treeEntry && treeEntry.type === 'file' && typeof treeEntry.path === 'string');
    }

    async processFilesWithConcurrency(plannedFiles, modelDirectory)
    {
        const outcomes = new Array(plannedFiles.length);
        let nextFileIndex = 0;

        const runWorker = async () =>
        {
            while (true)
            {
                const fileIndex = nextFileIndex;
                nextFileIndex++;
                if (fileIndex >= plannedFiles.length)
                {
                    return;
                }
                outcomes[fileIndex] = await this.processFile(plannedFiles[fileIndex], modelDirectory);
            }
        };

        const workerCount = Math.max(1, Math.min(this.concurrency, plannedFiles.length));
        const workers = [];
        for (let workerIndex = 0; workerIndex < workerCount; workerIndex++)
        {
            workers.push(runWorker());
        }
        await Promise.all(workers);

        return outcomes;
    }

    async processFile(plannedFile, modelDirectory)
    {
        const destinationPath = path.join(modelDirectory, ...plannedFile.relativePath.split('/'));

        if (!this.bForce && this.isFileAlreadyValid(plannedFile, destinationPath))
        {
            return { relativePath: plannedFile.relativePath, status: 'verified', sizeBytes: fs.statSync(destinationPath).size };
        }

        if (this.bVerifyOnly)
        {
            console.log(`    missing/unverified: ${plannedFile.relativePath}`);
            return { relativePath: plannedFile.relativePath, status: 'missing', sizeBytes: 0 };
        }

        await this.downloadFileWithRetries(plannedFile, destinationPath);
        return { relativePath: plannedFile.relativePath, status: 'downloaded', sizeBytes: fs.statSync(destinationPath).size };
    }

    isFileAlreadyValid(plannedFile, destinationPath)
    {
        if (!fs.existsSync(destinationPath))
        {
            return false;
        }

        const fileStatistics = fs.statSync(destinationPath);
        if (fileStatistics.size === 0)
        {
            return false;
        }
        if (plannedFile.sizeBytes > 0 && fileStatistics.size !== plannedFile.sizeBytes)
        {
            return false;
        }
        if (plannedFile.expectedSha256)
        {
            return LocalLlmModelProvisioner.computeSha256(destinationPath) === plannedFile.expectedSha256;
        }
        return true;
    }

    async downloadFileWithRetries(plannedFile, destinationPath)
    {
        let lastError = null;

        for (let attemptNumber = 1; attemptNumber <= LocalLlmModelProvisioner.MAXIMUM_ATTEMPTS_PER_FILE; attemptNumber++)
        {
            try
            {
                await this.downloadFileOnce(plannedFile, destinationPath);
                return;
            }
            catch (downloadError)
            {
                lastError = downloadError;
                if (attemptNumber < LocalLlmModelProvisioner.MAXIMUM_ATTEMPTS_PER_FILE)
                {
                    const delayMilliseconds = LocalLlmModelProvisioner.RETRY_BASE_DELAY_MILLISECONDS * attemptNumber;
                    console.warn(`    retry ${attemptNumber}/${LocalLlmModelProvisioner.MAXIMUM_ATTEMPTS_PER_FILE - 1}: ${plannedFile.relativePath} — ${downloadError.message}`);
                    await new Promise((resolve) => setTimeout(resolve, delayMilliseconds));
                }
            }
        }

        throw new Error(`${plannedFile.relativePath}: ${lastError ? lastError.message : 'unknown download error'}`);
    }

    async downloadFileOnce(plannedFile, destinationPath)
    {
        const partialPath = destinationPath + LocalLlmModelProvisioner.PARTIAL_FILE_SUFFIX;
        fs.mkdirSync(path.dirname(destinationPath), { recursive: true });

        const response = await fetch(plannedFile.sourceUrl, { redirect: 'follow' });
        if (!response.ok || !response.body)
        {
            throw new Error(`HTTP ${response.status}`);
        }

        await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(partialPath));

        const writtenSize = fs.statSync(partialPath).size;
        if (plannedFile.sizeBytes > 0 && writtenSize !== plannedFile.sizeBytes)
        {
            fs.rmSync(partialPath, { force: true });
            throw new Error(`size mismatch (expected ${plannedFile.sizeBytes}, got ${writtenSize})`);
        }
        if (plannedFile.expectedSha256)
        {
            const writtenSha256 = LocalLlmModelProvisioner.computeSha256(partialPath);
            if (writtenSha256 !== plannedFile.expectedSha256)
            {
                fs.rmSync(partialPath, { force: true });
                throw new Error('sha256 mismatch');
            }
        }

        fs.rmSync(destinationPath, { force: true });
        fs.renameSync(partialPath, destinationPath);
        console.log(`    fetched ${plannedFile.relativePath} (${LocalLlmModelProvisioner.formatBytes(writtenSize)})`);
    }

    assertRequiredFilesPresent(descriptor, modelDirectory)
    {
        const requiredFileNames = Array.isArray(descriptor.requiredFileNames) ? descriptor.requiredFileNames : [];
        const missingFileNames = [];

        for (const requiredFileName of requiredFileNames)
        {
            const requiredPath = path.join(modelDirectory, ...requiredFileName.split('/'));
            if (!fs.existsSync(requiredPath) || fs.statSync(requiredPath).size === 0)
            {
                missingFileNames.push(requiredFileName);
            }
        }

        if (missingFileNames.length > 0)
        {
            throw new Error(`required file(s) missing after provisioning: ${missingFileNames.join(', ')}`);
        }
    }

    /**
     * Prints the largest single parameter buffer the model contains. That
     * value is what a WebGPU adapter's maxStorageBufferBindingSize must
     * clear, so the catalogue's minimumMaxStorageBufferBindingSizeBytes can
     * be set from measurement instead of guesswork — which matters because
     * that number is exactly what decides whether a phone GPU is offered
     * this model or the next one down.
     */
    reportMeasuredBufferRequirement(descriptor, modelDirectory)
    {
        if (!descriptor.shardManifestFileName)
        {
            return;
        }

        const shardManifestPath = path.join(modelDirectory, descriptor.shardManifestFileName);
        if (!fs.existsSync(shardManifestPath))
        {
            return;
        }

        try
        {
            const shardManifest = JSON.parse(fs.readFileSync(shardManifestPath, 'utf8'));
            const records = Array.isArray(shardManifest.records) ? shardManifest.records : [];
            let largestBufferBytes = 0;

            for (const record of records)
            {
                const shardBytes = typeof record.nbytes === 'number' ? record.nbytes : 0;
                if (shardBytes > largestBufferBytes)
                {
                    largestBufferBytes = shardBytes;
                }
            }

            if (largestBufferBytes > 0)
            {
                const declaredMinimum = descriptor.minimumMaxStorageBufferBindingSizeBytes || 0;
                const suffix = largestBufferBytes > declaredMinimum
                    ? '  <-- EXCEEDS the catalogue minimum; raise minimumMaxStorageBufferBindingSizeBytes'
                    : '';
                console.log(`  largest parameter buffer: ${LocalLlmModelProvisioner.formatBytes(largestBufferBytes)} (catalogue minimum ${LocalLlmModelProvisioner.formatBytes(declaredMinimum)})${suffix}`);
            }
        }
        catch (manifestError)
        {
            console.warn(`  could not measure buffer requirement: ${manifestError.message}`);
        }
    }

    writeProvisionManifest(modelKey, descriptor, modelDirectory, outcomes)
    {
        const totalBytes = outcomes.reduce((runningTotal, outcome) => runningTotal + (outcome.sizeBytes || 0), 0);
        const manifestRecord =
        {
            modelKey: modelKey,
            engineModelId: descriptor.engineModelId,
            executionBackend: descriptor.executionBackend,
            sourceRepository: descriptor.sourceRepository,
            fileCount: outcomes.length,
            totalBytes: totalBytes,
            provisionedAt: new Date().toISOString(),
        };

        fs.writeFileSync(
            path.join(modelDirectory, LocalLlmModelProvisioner.PROVISION_MANIFEST_FILE_NAME),
            JSON.stringify(manifestRecord, null, 4),
            'utf8'
        );
    }

    async provisionOnnxRuntime()
    {
        console.log('\nONNX Runtime (CPU backend)');
        const runtimeDirectory = this.getOnnxRuntimeDirectory();

        if (!this.bVerifyOnly)
        {
            fs.mkdirSync(runtimeDirectory, { recursive: true });
        }

        for (const runtimeFileName of LocalLlmModelProvisioner.ONNX_RUNTIME_FILE_NAMES)
        {
            const destinationPath = path.join(runtimeDirectory, runtimeFileName);
            if (!this.bForce && fs.existsSync(destinationPath) && fs.statSync(destinationPath).size > 0)
            {
                console.log(`    already present: ${runtimeFileName}`);
                continue;
            }
            if (this.bVerifyOnly)
            {
                throw new Error(`${runtimeFileName} is missing`);
            }

            await this.downloadFileWithRetries(
            {
                relativePath: runtimeFileName,
                sourceUrl: `${LocalLlmModelProvisioner.ONNX_RUNTIME_SOURCE_URL}${runtimeFileName}`,
                sizeBytes: 0,
                expectedSha256: null,
            }, destinationPath);
        }
    }

    printCatalogue()
    {
        const orderedKeys = Array.isArray(this.catalogue.ORDER) ? this.catalogue.ORDER : [];
        console.log(`Assets root: ${this.destinationRoot}\n`);

        for (const modelKey of orderedKeys)
        {
            const descriptor = this.catalogue[modelKey];
            if (!descriptor)
            {
                console.log(`${modelKey.padEnd(28)}  MISSING FROM CATALOGUE BODY`);
                continue;
            }

            const modelDirectory = this.getModelDirectory(descriptor);
            let statusText = 'not provisioned';
            if (fs.existsSync(modelDirectory))
            {
                try
                {
                    this.assertRequiredFilesPresent(descriptor, modelDirectory);
                    statusText = 'provisioned';
                }
                catch (assertionError)
                {
                    statusText = 'incomplete';
                }
            }

            console.log(`${modelKey.padEnd(28)}  rank ${String(descriptor.preferenceRank).padStart(3)}  ${descriptor.executionBackend.padEnd(6)}  ${descriptor.approximateTotalLabel.padEnd(9)}  ${statusText}`);
        }
    }

    static computeSha256(filePath)
    {
        const hash = crypto.createHash('sha256');
        hash.update(fs.readFileSync(filePath));
        return hash.digest('hex');
    }

    static formatBytes(byteCount)
    {
        if (byteCount >= 1073741824)
        {
            return `${(byteCount / 1073741824).toFixed(2)} GB`;
        }
        if (byteCount >= 1048576)
        {
            return `${(byteCount / 1048576).toFixed(1)} MB`;
        }
        if (byteCount >= 1024)
        {
            return `${(byteCount / 1024).toFixed(1)} KB`;
        }
        return `${byteCount} B`;
    }

    static parseCommandLineArguments(argumentList, repositoryRoot)
    {
        const parsed =
        {
            repositoryRoot: repositoryRoot,
            destinationRoot: path.join(repositoryRoot, 'Dock', 'Assets'),
            requestedModelKeys: [],
            bForce: false,
            bVerifyOnly: false,
            bList: false,
            concurrency: LocalLlmModelProvisioner.DEFAULT_CONCURRENCY,
        };

        for (const argument of argumentList)
        {
            if (argument === '--force')
            {
                parsed.bForce = true;
            }
            else if (argument === '--verify-only')
            {
                parsed.bVerifyOnly = true;
            }
            else if (argument === '--list')
            {
                parsed.bList = true;
            }
            else if (argument.startsWith('--models='))
            {
                parsed.requestedModelKeys = argument.slice('--models='.length)
                    .split(',')
                    .map((modelKey) => modelKey.trim())
                    .filter((modelKey) => modelKey.length > 0);
            }
            else if (argument.startsWith('--destination='))
            {
                parsed.destinationRoot = path.resolve(argument.slice('--destination='.length));
            }
            else if (argument.startsWith('--concurrency='))
            {
                const parsedConcurrency = Number.parseInt(argument.slice('--concurrency='.length), 10);
                parsed.concurrency = Number.isFinite(parsedConcurrency) && parsedConcurrency > 0
                    ? parsedConcurrency
                    : LocalLlmModelProvisioner.DEFAULT_CONCURRENCY;
            }
            else
            {
                throw new Error(`Unrecognised argument: ${argument}`);
            }
        }

        return parsed;
    }
}

(async () =>
{
    const repositoryRoot = path.join(__dirname, '..', '..');

    try
    {
        const options = LocalLlmModelProvisioner.parseCommandLineArguments(process.argv.slice(2), repositoryRoot);
        const provisioner = new LocalLlmModelProvisioner(options);

        if (options.bList)
        {
            provisioner.printCatalogue();
            return;
        }

        await provisioner.run();
    }
    catch (fatalError)
    {
        console.error(`Provisioning failed: ${fatalError.message}`);
        process.exitCode = 1;
    }
})();

module.exports = LocalLlmModelProvisioner;
