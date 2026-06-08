const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');
const CleanCss = require('clean-css');
const { minify: minifyHtmlSource } = require('html-minifier-terser');

class MinifyAndObfuscateWorker
{
    constructor(workerConfiguration)
    {
        this.javascriptObfuscatorOptions = workerConfiguration.javascriptObfuscatorOptions;
        this.htmlMinifierOptions         = workerConfiguration.htmlMinifierOptions;
        this.cleanCssMinifier            = new CleanCss({ level: 2, returnPromise: false, inline: false });
    }

    listen()
    {
        parentPort.on('message', async (message) =>
        {
            if (message.type === 'shutdown')
            {
                process.exit(0);
                return;
            }

            if (message.type === 'process')
            {
                try
                {
                    await this.processFile(message.filePath);
                    parentPort.postMessage({ type: 'done', filePath: message.filePath });
                }
                catch (error)
                {
                    parentPort.postMessage({
                        type: 'error',
                        filePath: message.filePath,
                        errorMessage: error && error.stack ? error.stack : String(error),
                    });
                }
            }
        });
    }

    async processFile(filePath)
    {
        const extension = path.extname(filePath).toLowerCase();

        if (extension === '.js')
        {
            const source = fs.readFileSync(filePath, 'utf8');
            const obfuscated = JavaScriptObfuscator.obfuscate(source, this.javascriptObfuscatorOptions).getObfuscatedCode();
            fs.writeFileSync(filePath, obfuscated, 'utf8');
            return;
        }

        if (extension === '.css')
        {
            const source = fs.readFileSync(filePath, 'utf8');
            const result = this.cleanCssMinifier.minify(source);
            if (result.errors && result.errors.length > 0)
            {
                throw new Error(`clean-css errors in ${filePath}: ${result.errors.join('; ')}`);
            }
            fs.writeFileSync(filePath, result.styles, 'utf8');
            return;
        }

        if (extension === '.html')
        {
            const source = fs.readFileSync(filePath, 'utf8');
            const minified = await minifyHtmlSource(source, this.htmlMinifierOptions);
            fs.writeFileSync(filePath, minified, 'utf8');
            return;
        }

        throw new Error(`Worker received unsupported extension for ${filePath}`);
    }
}

new MinifyAndObfuscateWorker(workerData).listen();
