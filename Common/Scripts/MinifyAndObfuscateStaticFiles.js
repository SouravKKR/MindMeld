const fs = require('fs');
const path = require('path');
const os = require('os');
const { Worker } = require('worker_threads');

class StaticFileMinifier
{
    static SKIPPED_DIRECTORIES = new Set([
        'ThirdParty',
    ]);

    static MIN_WORKER_COUNT = 1;
    static MAX_WORKER_COUNT = 8;

    constructor(staticDirectory, useAggressiveObfuscation)
    {
        this.staticDirectory             = staticDirectory;
        this.useAggressiveObfuscation    = useAggressiveObfuscation;
        this.workerScriptPath            = path.join(__dirname, 'MinifyAndObfuscateWorker.js');
        this.javascriptObfuscatorOptions = this.buildObfuscatorOptions();
        this.htmlMinifierOptions = {
            collapseWhitespace: true,
            removeComments: true,
            minifyCSS: true,
            minifyJS: false,
            keepClosingSlash: true,
            removeAttributeQuotes: false,
        };
    }

    buildObfuscatorOptions()
    {
        // renameGlobals is intentionally disabled — the bundler now emits a
        // tiny *Bundle.js proxy plus N part/chunk files that import each
        // other by name across module boundaries. Renaming top-level
        // identifiers would silently break those cross-file imports.
        const conservativeOptions = {
            compact: true,
            target: 'browser',
            identifierNamesGenerator: 'mangled-shuffled',
            renameGlobals: false,
            transformObjectKeys: false,
            stringArray: true,
            stringArrayEncoding: ['base64'],
            stringArrayThreshold: 0.75,
            splitStrings: false,
            controlFlowFlattening: false,
            deadCodeInjection: false,
            selfDefending: false,
            debugProtection: false,
            disableConsoleOutput: true,
            simplify: false,
            unicodeEscapeSequence: false,
            domainLock: [],
            domainLockRedirectUrl: 'about:blank',
        };

        if (!this.useAggressiveObfuscation)
        {
            return conservativeOptions;
        }

        return {
            ...conservativeOptions,
            stringArrayEncoding: ['rc4'],
            stringArrayThreshold: 1.0,
            stringArrayCallsTransform: true,
            stringArrayCallsTransformThreshold: 0.75,
            stringArrayWrappersCount: 2,
            stringArrayWrappersType: 'function',
            stringArrayWrappersChainedCalls: false,
            stringArrayWrappersParametersMaxCount: 4,
            splitStrings: true,
            splitStringsChunkLength: 10,
            numbersToExpressions: true,
            selfDefending: true,
            debugProtection: false,
            controlFlowFlattening: true,
            deadCodeInjection: true,
        };
    }

    async run()
    {
        if (!fs.existsSync(this.staticDirectory))
        {
            console.error(`Static directory not found: ${this.staticDirectory}`);
            process.exit(1);
        }

        const profileName = this.useAggressiveObfuscation ? 'aggressive' : 'conservative';
        const startTime = Date.now();

        const { eligibleFilePaths, skippedFileCount } = this.collectEligibleFiles(this.staticDirectory);

        const workerCount = this.calculateWorkerCount(eligibleFilePaths.length);
        console.log(`Minifying + obfuscating Dock/Static/ (profile: ${profileName}, ${eligibleFilePaths.length} file(s) across ${workerCount} worker(s))...`);

        await this.processFilesInParallel(eligibleFilePaths, workerCount);

        const elapsedSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`Done. Processed ${eligibleFilePaths.length} file(s), skipped ${skippedFileCount} in ${elapsedSeconds}s.`);
    }

    collectEligibleFiles(rootDirectory)
    {
        const eligibleFilePaths = [];
        let skippedFileCount = 0;

        const walk = (currentDirectory) =>
        {
            const entries = fs.readdirSync(currentDirectory, { withFileTypes: true });

            for (const entry of entries)
            {
                const entryPath = path.join(currentDirectory, entry.name);

                if (entry.isDirectory())
                {
                    if (StaticFileMinifier.SKIPPED_DIRECTORIES.has(entry.name))
                    {
                        continue;
                    }
                    walk(entryPath);
                    continue;
                }

                const lowerCaseName = entry.name.toLowerCase();
                const extension     = path.extname(lowerCaseName);

                if (extension === '.js')
                {
                    if (lowerCaseName.endsWith('.min.js'))
                    {
                        skippedFileCount++;
                        continue;
                    }
                    eligibleFilePaths.push(entryPath);
                }
                else if (extension === '.css')
                {
                    if (lowerCaseName.endsWith('.min.css'))
                    {
                        skippedFileCount++;
                        continue;
                    }
                    eligibleFilePaths.push(entryPath);
                }
                else if (extension === '.html')
                {
                    eligibleFilePaths.push(entryPath);
                }
                else
                {
                    skippedFileCount++;
                }
            }
        };
        walk(rootDirectory);

        // Process the largest files first. JavaScript obfuscation scales
        // super-linearly with file size, so feeding the biggest payload to
        // the first idle worker minimises the chance that a giant file
        // arrives last and stretches the wall-clock tail.
        eligibleFilePaths.sort((leftPath, rightPath) =>
        {
            const leftSize  = fs.statSync(leftPath).size;
            const rightSize = fs.statSync(rightPath).size;
            return rightSize - leftSize;
        });

        return { eligibleFilePaths, skippedFileCount };
    }

    calculateWorkerCount(fileCount)
    {
        const cpuCount = os.cpus().length;
        const ceiling  = Math.max(StaticFileMinifier.MIN_WORKER_COUNT, Math.min(StaticFileMinifier.MAX_WORKER_COUNT, cpuCount - 1));
        return Math.max(StaticFileMinifier.MIN_WORKER_COUNT, Math.min(ceiling, fileCount));
    }

    async processFilesInParallel(filePaths, workerCount)
    {
        if (filePaths.length === 0)
        {
            return;
        }

        const workerConfiguration = {
            javascriptObfuscatorOptions: this.javascriptObfuscatorOptions,
            htmlMinifierOptions: this.htmlMinifierOptions,
        };

        await new Promise((resolve, reject) =>
        {
            const workers = [];
            let nextFileIndex = 0;
            let completedCount = 0;
            let hasSettled = false;

            const finalise = (errorOrNull) =>
            {
                if (hasSettled)
                {
                    return;
                }
                hasSettled = true;
                Promise.all(workers.map((worker) => worker.terminate().catch(() => {})))
                    .then(() =>
                    {
                        if (errorOrNull)
                        {
                            reject(errorOrNull);
                        }
                        else
                        {
                            resolve();
                        }
                    });
            };

            const dispatchNext = (worker) =>
            {
                if (hasSettled)
                {
                    return;
                }
                if (nextFileIndex >= filePaths.length)
                {
                    worker.postMessage({ type: 'shutdown' });
                    return;
                }
                worker.postMessage({ type: 'process', filePath: filePaths[nextFileIndex++] });
            };

            for (let workerIndex = 0; workerIndex < workerCount; workerIndex++)
            {
                const worker = new Worker(this.workerScriptPath, { workerData: workerConfiguration });
                workers.push(worker);

                worker.on('message', (message) =>
                {
                    if (message.type === 'done')
                    {
                        completedCount++;
                        if (completedCount === filePaths.length)
                        {
                            finalise(null);
                            return;
                        }
                        dispatchNext(worker);
                    }
                    else if (message.type === 'error')
                    {
                        finalise(new Error(`Failed to process ${message.filePath}:\n${message.errorMessage}`));
                    }
                });

                worker.on('error', (workerError) =>
                {
                    finalise(workerError);
                });

                worker.on('exit', (exitCode) =>
                {
                    if (exitCode !== 0 && !hasSettled)
                    {
                        finalise(new Error(`Worker exited with code ${exitCode} before completing all files.`));
                    }
                });

                dispatchNext(worker);
            }
        });
    }
}

(async () =>
{
    const useAggressiveObfuscation = process.argv.includes('--aggressive');
    const staticDirectory = path.join(__dirname, '..', '..', 'Dock', 'Static');
    const minifier = new StaticFileMinifier(staticDirectory, useAggressiveObfuscation);
    try
    {
        await minifier.run();
    }
    catch (error)
    {
        console.error('Minification + obfuscation failed:');
        console.error(error);
        process.exit(1);
    }
})();
