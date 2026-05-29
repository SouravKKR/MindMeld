const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

class StaticBundler
{
    static ENTRY_FILENAME = '.bundle-entry.js';
    static SKIPPED_TOP_LEVEL_DIRECTORIES = new Set(['ThirdParty']);
    static DELETABLE_EXTENSIONS = new Set(['.js', '.css']);

    // Each HTML entry point gets its own pair of bundles. The login shell
    // lives outside the SPA so unauthenticated visitors download only the
    // tiny LoginBundle.* pair instead of the full Bundle.* SPA. Add a
    // future shell by appending another { htmlFileName, javascriptBundleName,
    // cssBundleName } entry here.
    static HTML_ENTRY_POINTS = [
        { htmlFileName: 'index.html', javascriptBundleName: 'Bundle.js',      cssBundleName: 'Bundle.css' },
        { htmlFileName: 'login.html', javascriptBundleName: 'LoginBundle.js', cssBundleName: 'LoginBundle.css' },
    ];

    constructor(staticDirectory)
    {
        this.staticDirectory = staticDirectory;
        this.entryPath = path.join(staticDirectory, StaticBundler.ENTRY_FILENAME);

        // Absolute paths of every bundle file produced this run. The
        // post-bundle source-sweep skips these so we don't delete our
        // own outputs.
        this.preservedBundlePaths = new Set();
    }

    async run()
    {
        if (!fs.existsSync(this.staticDirectory))
        {
            console.error(`Static directory not found: ${this.staticDirectory}`);
            process.exit(1);
        }

        const startTime = Date.now();

        let totalScriptEntryCount = 0;
        let totalStylesheetEntryCount = 0;
        let processedEntryCount = 0;

        for (const entry of StaticBundler.HTML_ENTRY_POINTS)
        {
            const htmlPath = path.join(this.staticDirectory, entry.htmlFileName);

            if (!fs.existsSync(htmlPath))
            {
                // Each shell is optional — skip silently so adding a new
                // shell only to Common/ (without yet writing the html in
                // Main/) doesn't fail the build.
                continue;
            }

            console.log(`Bundling ${entry.htmlFileName}...`);

            const counts = await this.bundleEntryPoint(htmlPath, entry);
            totalScriptEntryCount     += counts.scriptCount;
            totalStylesheetEntryCount += counts.stylesheetCount;
            processedEntryCount++;
        }

        if (processedEntryCount === 0)
        {
            console.error('No HTML entry points were found to bundle.');
            process.exit(1);
        }

        const deletedCount = this.deleteEntryPointSources();
        const removedDirectoryCount = this.removeEmptyDirectories();

        const elapsedSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`Done. Bundled ${processedEntryCount} entry point(s): ${totalScriptEntryCount} JS entry(ies) + ${totalStylesheetEntryCount} CSS file(s), deleted ${deletedCount} now-unused source file(s), pruned ${removedDirectoryCount} empty director(ies) in ${elapsedSeconds}s.`);
    }

    async bundleEntryPoint(htmlPath, entry)
    {
        const javascriptBundlePath = path.join(this.staticDirectory, entry.javascriptBundleName);
        const cssBundlePath        = path.join(this.staticDirectory, entry.cssBundleName);

        const originalHtml = fs.readFileSync(htmlPath, 'utf8');
        const moduleScriptSources = this.extractRelativeModuleScriptSources(originalHtml);
        const stylesheetSources   = this.extractRelativeStylesheetSources(originalHtml);

        if (moduleScriptSources.length === 0)
        {
            console.error(`No relative type="module" scripts found in ${entry.htmlFileName} to bundle.`);
            process.exit(1);
        }

        this.writeEntryFile(moduleScriptSources);

        try
        {
            await this.buildJavascriptBundle(javascriptBundlePath);
        }
        finally
        {
            if (fs.existsSync(this.entryPath))
            {
                fs.unlinkSync(this.entryPath);
            }
        }

        this.preservedBundlePaths.add(javascriptBundlePath);

        if (stylesheetSources.length > 0)
        {
            const bundledCss = this.buildCssBundle(stylesheetSources);
            fs.writeFileSync(cssBundlePath, bundledCss, 'utf8');
            this.preservedBundlePaths.add(cssBundlePath);
        }

        const rewrittenHtml = this.rewriteHtml(
            originalHtml,
            moduleScriptSources,
            stylesheetSources,
            entry.javascriptBundleName,
            entry.cssBundleName
        );
        fs.writeFileSync(htmlPath, rewrittenHtml, 'utf8');

        return { scriptCount: moduleScriptSources.length, stylesheetCount: stylesheetSources.length };
    }

    extractRelativeModuleScriptSources(html)
    {
        const moduleScriptRegex = /<script\b[^>]*\btype\s*=\s*["']module["'][^>]*>\s*<\/script>/gi;
        const sources = [];
        const matches = html.match(moduleScriptRegex) || [];

        for (const match of matches)
        {
            const sourceMatch = match.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
            if (!sourceMatch)
            {
                continue;
            }
            const sourceUrl = sourceMatch[1];
            if (sourceUrl.startsWith('http://') || sourceUrl.startsWith('https://') || sourceUrl.startsWith('//'))
            {
                continue;
            }
            sources.push(sourceUrl);
        }

        return sources;
    }

    writeEntryFile(moduleScriptSources)
    {
        const importStatements = moduleScriptSources
            .map(sourceUrl => `import ${JSON.stringify(this.normaliseImportPath(sourceUrl))};`)
            .join('\n');
        fs.writeFileSync(this.entryPath, importStatements + '\n', 'utf8');
    }

    normaliseImportPath(sourceUrl)
    {
        if (sourceUrl.startsWith('./') || sourceUrl.startsWith('../'))
        {
            return sourceUrl;
        }
        if (sourceUrl.startsWith('/'))
        {
            return '.' + sourceUrl;
        }
        return './' + sourceUrl;
    }

    async buildJavascriptBundle(javascriptBundlePath)
    {
        await esbuild.build({
            entryPoints: [this.entryPath],
            bundle: true,
            format: 'esm',
            target: 'es2022',
            outfile: javascriptBundlePath,
            sourcemap: false,
            minify: true,
            legalComments: 'none',
            absWorkingDir: this.staticDirectory,
            logLevel: 'warning',
        });
    }

    extractRelativeStylesheetSources(html)
    {
        const linkRegex = /<link\b[^>]*\brel\s*=\s*["']stylesheet["'][^>]*>/gi;
        const sources = [];
        const matches = html.match(linkRegex) || [];

        for (const match of matches)
        {
            const hrefMatch = match.match(/\bhref\s*=\s*["']([^"']+)["']/i);
            if (!hrefMatch)
            {
                continue;
            }
            const hrefValue = hrefMatch[1];
            if (hrefValue.startsWith('http://') || hrefValue.startsWith('https://') || hrefValue.startsWith('//'))
            {
                continue;
            }
            sources.push(hrefValue);
        }

        return sources;
    }

    buildCssBundle(stylesheetSources)
    {
        const visited = new Set();
        const chunks = [];

        const visit = (relativePath) =>
        {
            const normalised = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
            if (visited.has(normalised))
            {
                return;
            }
            visited.add(normalised);

            const absolutePath = path.join(this.staticDirectory, normalised);
            if (!fs.existsSync(absolutePath))
            {
                throw new Error(`Stylesheet not found while bundling CSS: ${normalised}`);
            }
            const sourceDirectoryRelative = path.posix.dirname(normalised);
            const rawContent = fs.readFileSync(absolutePath, 'utf8');
            const transformed = this.transformCssContent(rawContent, sourceDirectoryRelative, visit);
            chunks.push(transformed);
        };

        for (const source of stylesheetSources)
        {
            visit(source);
        }

        return chunks.join('\n');
    }

    transformCssContent(content, sourceDirectoryRelative, visit)
    {
        const importRegex = /@import\s+(?:url\(\s*)?["']?([^"')\s]+)["']?\s*\)?\s*;/g;
        const withoutImports = content.replace(importRegex, (_match, importPath) =>
        {
            if (importPath.startsWith('http://') || importPath.startsWith('https://') || importPath.startsWith('data:'))
            {
                return `@import url("${importPath}");`;
            }
            const resolved = this.resolveRelativePosix(sourceDirectoryRelative, importPath);
            visit(resolved);
            return '';
        });

        const urlRegex = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
        const rewritten = withoutImports.replace(urlRegex, (match, quote, urlPath) =>
        {
            if (urlPath.startsWith('http://') || urlPath.startsWith('https://') || urlPath.startsWith('data:') || urlPath.startsWith('//') || urlPath.startsWith('#'))
            {
                return match;
            }
            const resolved = this.resolveRelativePosix(sourceDirectoryRelative, urlPath);
            return `url(${quote}./${resolved}${quote})`;
        });

        return rewritten;
    }

    resolveRelativePosix(baseDirectory, relativePath)
    {
        if (relativePath.startsWith('/'))
        {
            return relativePath.replace(/^\/+/, '');
        }
        const joined = baseDirectory ? `${baseDirectory}/${relativePath}` : relativePath;
        const segments = joined.split('/');
        const resolved = [];
        for (const segment of segments)
        {
            if (segment === '' || segment === '.')
            {
                continue;
            }
            if (segment === '..')
            {
                resolved.pop();
                continue;
            }
            resolved.push(segment);
        }
        return resolved.join('/');
    }

    rewriteHtml(originalHtml, moduleScriptSources, stylesheetSources, javascriptBundleName, cssBundleName)
    {
        const escapedScriptSources = moduleScriptSources.map(source => this.escapeRegex(source));
        const moduleTagRegex = new RegExp(
            `\\s*<script\\b(?=[^>]*\\btype\\s*=\\s*["']module["'])(?=[^>]*\\bsrc\\s*=\\s*["'](?:${escapedScriptSources.join('|')})["'])[^>]*>\\s*<\\/script>`,
            'gi'
        );

        let stripped = originalHtml.replace(moduleTagRegex, '');

        if (stylesheetSources.length > 0)
        {
            const escapedStylesheetSources = stylesheetSources.map(source => this.escapeRegex(source));
            const linkTagRegex = new RegExp(
                `\\s*<link\\b(?=[^>]*\\brel\\s*=\\s*["']stylesheet["'])(?=[^>]*\\bhref\\s*=\\s*["'](?:${escapedStylesheetSources.join('|')})["'])[^>]*>`,
                'gi'
            );
            stripped = stripped.replace(linkTagRegex, '');
        }

        const headCloseIndex = stripped.search(/<\/head>/i);
        if (headCloseIndex === -1)
        {
            throw new Error('Could not locate </head> to inject bundle tag.');
        }

        const bundleTags = [];
        if (stylesheetSources.length > 0)
        {
            bundleTags.push(`    <link rel="stylesheet" href="./${cssBundleName}">`);
        }
        bundleTags.push(`    <script src="./${javascriptBundleName}" type="module"></script>`);
        const injection = '\n' + bundleTags.join('\n') + '\n';

        return stripped.slice(0, headCloseIndex) + injection + stripped.slice(headCloseIndex);
    }

    escapeRegex(value)
    {
        return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    deleteEntryPointSources()
    {
        let deletedCount = 0;
        const walk = (currentDirectory) =>
        {
            const entries = fs.readdirSync(currentDirectory, { withFileTypes: true });
            for (const entry of entries)
            {
                const entryPath = path.join(currentDirectory, entry.name);
                if (entry.isDirectory())
                {
                    if (currentDirectory === this.staticDirectory && StaticBundler.SKIPPED_TOP_LEVEL_DIRECTORIES.has(entry.name))
                    {
                        continue;
                    }
                    walk(entryPath);
                }
                else if (entry.isFile())
                {
                    const extension = path.extname(entry.name).toLowerCase();
                    if (!StaticBundler.DELETABLE_EXTENSIONS.has(extension))
                    {
                        continue;
                    }
                    if (this.preservedBundlePaths.has(entryPath))
                    {
                        continue;
                    }
                    fs.unlinkSync(entryPath);
                    deletedCount++;
                }
            }
        };
        walk(this.staticDirectory);
        return deletedCount;
    }

    removeEmptyDirectories()
    {
        let removedCount = 0;
        const prune = (currentDirectory) =>
        {
            if (currentDirectory === this.staticDirectory)
            {
                const entries = fs.readdirSync(currentDirectory, { withFileTypes: true });
                for (const entry of entries)
                {
                    if (entry.isDirectory() && !StaticBundler.SKIPPED_TOP_LEVEL_DIRECTORIES.has(entry.name))
                    {
                        prune(path.join(currentDirectory, entry.name));
                    }
                }
                return false;
            }

            const entries = fs.readdirSync(currentDirectory, { withFileTypes: true });
            for (const entry of entries)
            {
                if (entry.isDirectory())
                {
                    prune(path.join(currentDirectory, entry.name));
                }
            }

            const remaining = fs.readdirSync(currentDirectory);
            if (remaining.length === 0)
            {
                fs.rmdirSync(currentDirectory);
                removedCount++;
                return true;
            }
            return false;
        };
        prune(this.staticDirectory);
        return removedCount;
    }
}

(async () =>
{
    const staticDirectory = path.join(__dirname, '..', '..', 'Dock', 'Static');
    const bundler = new StaticBundler(staticDirectory);
    try
    {
        await bundler.run();
    }
    catch (error)
    {
        console.error('Bundling failed:');
        console.error(error);
        process.exit(1);
    }
})();
