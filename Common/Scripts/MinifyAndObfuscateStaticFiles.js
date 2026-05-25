const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');
const CleanCss = require('clean-css');
const { minify: minifyHtmlSource } = require('html-minifier-terser');

class StaticFileMinifier
{
    static SKIPPED_DIRECTORIES = new Set([
        'ThirdParty',
    ]);

    constructor(staticDirectory, useAggressiveObfuscation)
    {
        this.staticDirectory = staticDirectory;
        this.useAggressiveObfuscation = useAggressiveObfuscation;
        this.cleanCssMinifier = new CleanCss({ level: 2, returnPromise: false, inline: false });
        this.htmlMinifierOptions = {
            collapseWhitespace: true,
            removeComments: true,
            minifyCSS: true,
            minifyJS: false,
            keepClosingSlash: true,
            removeAttributeQuotes: false,
        };
        this.javascriptObfuscatorOptions = this.buildObfuscatorOptions();
        this.processedFileCount = 0;
        this.skippedFileCount = 0;
    }

    buildObfuscatorOptions()
    {
        const conservativeOptions = {
            compact: true,
            target: 'browser',
            identifierNamesGenerator: 'mangled-shuffled',
            renameGlobals: true,
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
        console.log(`Minifying + obfuscating Dock/Static/ (profile: ${profileName})...`);

        const startTime = Date.now();
        await this.processDirectory(this.staticDirectory);
        const elapsedSeconds = ((Date.now() - startTime) / 1000).toFixed(1);

        console.log(`Done. Processed ${this.processedFileCount} file(s), skipped ${this.skippedFileCount} in ${elapsedSeconds}s.`);
    }

    async processDirectory(currentDirectory)
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
                await this.processDirectory(entryPath);
            }
            else
            {
                await this.processFile(entryPath);
            }
        }
    }

    async processFile(filePath)
    {
        const extension = path.extname(filePath).toLowerCase();

        try
        {
            if (extension === '.js')
            {
                if (filePath.toLowerCase().endsWith('.min.js'))
                {
                    this.skippedFileCount++;
                    return;
                }
                const source = fs.readFileSync(filePath, 'utf8');
                const obfuscated = this.obfuscateJavaScript(source);
                fs.writeFileSync(filePath, obfuscated, 'utf8');
                this.processedFileCount++;
            }
            else if (extension === '.css')
            {
                if (filePath.toLowerCase().endsWith('.min.css'))
                {
                    this.skippedFileCount++;
                    return;
                }
                const source = fs.readFileSync(filePath, 'utf8');
                const minified = this.minifyCss(source, filePath);
                fs.writeFileSync(filePath, minified, 'utf8');
                this.processedFileCount++;
            }
            else if (extension === '.html')
            {
                const source = fs.readFileSync(filePath, 'utf8');
                const minified = await this.minifyHtml(source);
                fs.writeFileSync(filePath, minified, 'utf8');
                this.processedFileCount++;
            }
            else
            {
                this.skippedFileCount++;
            }
        }
        catch (error)
        {
            console.error(`Failed to process ${filePath}:`);
            console.error(error);
            process.exit(1);
        }
    }

    obfuscateJavaScript(source)
    {
        const result = JavaScriptObfuscator.obfuscate(source, this.javascriptObfuscatorOptions);
        return result.getObfuscatedCode();
    }

    minifyCss(source, filePath)
    {
        const result = this.cleanCssMinifier.minify(source);
        if (result.errors && result.errors.length > 0)
        {
            throw new Error(`clean-css errors in ${filePath}: ${result.errors.join('; ')}`);
        }
        return result.styles;
    }

    async minifyHtml(source)
    {
        return await minifyHtmlSource(source, this.htmlMinifierOptions);
    }
}

(async () =>
{
    const useAggressiveObfuscation = process.argv.includes('--aggressive');
    const staticDirectory = path.join(__dirname, '..', '..', 'Dock', 'Static');
    const minifier = new StaticFileMinifier(staticDirectory, useAggressiveObfuscation);
    await minifier.run();
})();
