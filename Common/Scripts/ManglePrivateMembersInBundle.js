const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

class PrivateMemberMangler
{
    static IGNORED_AST_KEYS = new Set(['parent', 'loc', 'start', 'end', 'range', 'comments', 'tokens']);

    constructor(bundlePath)
    {
        this.bundlePath = bundlePath;
        this.totalClassCount = 0;
        this.totalRenamedReferenceCount = 0;
        this.totalDistinctNameCount = 0;
    }

    run()
    {
        if (!fs.existsSync(this.bundlePath))
        {
            console.error(`Bundle not found at ${this.bundlePath}`);
            process.exit(1);
        }

        const startTime = Date.now();
        console.log(`Mangling #private members in ${path.basename(this.bundlePath)}...`);

        const source = fs.readFileSync(this.bundlePath, 'utf8');
        const ast = acorn.parse(source, { ecmaVersion: 2022, sourceType: 'module', allowAwaitOutsideFunction: true });

        const edits = [];
        this.walkLookingForClasses(ast, edits);

        const rewritten = this.applyEdits(source, edits);
        fs.writeFileSync(this.bundlePath, rewritten, 'utf8');

        const elapsedSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`Done. Mangled ${this.totalDistinctNameCount} distinct private name(s) across ${this.totalClassCount} class(es) (${this.totalRenamedReferenceCount} reference(s) rewritten) in ${elapsedSeconds}s.`);
    }

    walkLookingForClasses(node, edits)
    {
        if (node === null || typeof node !== 'object')
        {
            return;
        }
        if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression')
        {
            this.processClass(node, edits);
            return;
        }
        for (const key in node)
        {
            if (PrivateMemberMangler.IGNORED_AST_KEYS.has(key))
            {
                continue;
            }
            const child = node[key];
            if (Array.isArray(child))
            {
                for (const item of child)
                {
                    this.walkLookingForClasses(item, edits);
                }
            }
            else if (child !== null && typeof child === 'object' && typeof child.type === 'string')
            {
                this.walkLookingForClasses(child, edits);
            }
        }
    }

    processClass(classNode, edits)
    {
        this.totalClassCount++;
        const nameMapping = new Map();
        let nameCounter = 0;

        const generateMangledName = () =>
        {
            let value = nameCounter++;
            let name = '';
            while (true)
            {
                name = String.fromCharCode(97 + (value % 26)) + name;
                value = Math.floor(value / 26) - 1;
                if (value < 0)
                {
                    break;
                }
            }
            return name;
        };

        const processNode = (node) =>
        {
            if (node === null || typeof node !== 'object')
            {
                return;
            }
            if (node.type === 'PrivateIdentifier')
            {
                if (!nameMapping.has(node.name))
                {
                    nameMapping.set(node.name, generateMangledName());
                    this.totalDistinctNameCount++;
                }
                const mangled = nameMapping.get(node.name);
                edits.push({ start: node.start, end: node.end, replacement: '#' + mangled });
                this.totalRenamedReferenceCount++;
                return;
            }
            if ((node.type === 'ClassDeclaration' || node.type === 'ClassExpression') && node !== classNode)
            {
                this.processClass(node, edits);
                return;
            }
            for (const key in node)
            {
                if (PrivateMemberMangler.IGNORED_AST_KEYS.has(key))
                {
                    continue;
                }
                const child = node[key];
                if (Array.isArray(child))
                {
                    for (const item of child)
                    {
                        processNode(item);
                    }
                }
                else if (child !== null && typeof child === 'object' && typeof child.type === 'string')
                {
                    processNode(child);
                }
            }
        };

        processNode(classNode.body);
    }

    applyEdits(source, edits)
    {
        edits.sort((leftEdit, rightEdit) => rightEdit.start - leftEdit.start);
        let result = source;
        for (const edit of edits)
        {
            result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
        }
        return result;
    }
}

function findBundleFiles(staticDirectory)
{
    // BundleStaticFiles.js now code-splits each HTML entry into:
    //   - a tiny *Bundle.js proxy (re-imports every part)
    //   - one *Bundle.part-<hash>.js per esbuild entry-point split
    //   - zero or more *Bundle.chunk-<hash>.js shared between parts
    // We mangle private members in all of them so the obfuscation step
    // downstream sees uniformly mangled identifiers. The proxy contains no
    // classes so it's a no-op but staying in the list is harmless.
    if (!fs.existsSync(staticDirectory))
    {
        return [];
    }

    const bundleOutputRegex = /Bundle\.(part|chunk)-[A-Za-z0-9_-]+\.js$/;

    return fs.readdirSync(staticDirectory, { withFileTypes: true })
        .filter((entry) =>
        {
            if (!entry.isFile())
            {
                return false;
            }
            return entry.name.endsWith('Bundle.js') || bundleOutputRegex.test(entry.name);
        })
        .map((entry) => path.join(staticDirectory, entry.name));
}

(() =>
{
    const staticDirectory = path.join(__dirname, '..', '..', 'Dock', 'Static');
    const bundlePaths = findBundleFiles(staticDirectory);

    if (bundlePaths.length === 0)
    {
        console.error(`No *Bundle.js files found in ${staticDirectory} to mangle.`);
        process.exit(1);
    }

    for (const bundlePath of bundlePaths)
    {
        const mangler = new PrivateMemberMangler(bundlePath);
        try
        {
            mangler.run();
        }
        catch (error)
        {
            console.error(`Private-member mangling failed for ${path.basename(bundlePath)}:`);
            console.error(error);
            process.exit(1);
        }
    }
})();
