const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Records the exact bytes of every executable file the build emits into
// Dock/Static, so the running server can later prove that what it is serving is
// still what the build produced.
//
// This is the first half of PCI DSS 11.6.1 / the Razorpay handbook's control 113
// (client-side script integrity monitoring). Subresource Integrity cannot cover
// these files: they are same-origin, so an attacker able to rewrite a bundle can
// rewrite the integrity attribute pointing at it in the same breath. A manifest
// written at BUILD time and checked at RUN time is not vulnerable that way,
// because the two happen on different machines at different times — tampering
// with the served tree does not retroactively change what the build recorded.
//
// The manifest deliberately lives OUTSIDE Dock/Static:
//   • Dock/Static is wiped and re-copied by CopyStaticFiles.js on every build.
//   • Anything inside it is servable, and publishing a hash list of every asset
//     hands an attacker a map of exactly what they need to keep consistent.
//   • A manifest inside the tree it describes would have to exclude itself,
//     which is precisely the hole worth not building.
//
// Hashes are sha384/base64 — the same shape as an SRI `integrity` attribute, so
// any entry here can be pasted into a <script integrity="..."> later without
// recomputation.
class GenerateScriptIntegrityManifest
{
    // What a browser can EXECUTE, plus the documents that decide what executes.
    // Stylesheets and images are excluded deliberately: they cannot run script,
    // and including every asset would make the manifest large enough that the
    // periodic re-hash stops being cheap.
    static HASHED_EXTENSIONS = new Set(['.js', '.mjs', '.html']);

    static SKIPPED_DIRECTORY_NAMES = new Set(['node_modules', '.git']);

    static HASH_ALGORITHM = 'sha384';

    static MANIFEST_RELATIVE_PATH = path.join('Dock', 'ScriptIntegrityManifest.json');

    constructor(repositoryRootDirectory)
    {
        this.repositoryRootDirectory = repositoryRootDirectory;
        this.staticDirectory = path.join(repositoryRootDirectory, 'Dock', 'Static');
        this.manifestFilePath = path.join(repositoryRootDirectory, GenerateScriptIntegrityManifest.MANIFEST_RELATIVE_PATH);
    }

    static hashFileContents(fileContents)
    {
        return `${GenerateScriptIntegrityManifest.HASH_ALGORITHM}-${crypto.createHash(GenerateScriptIntegrityManifest.HASH_ALGORITHM).update(fileContents).digest('base64')}`;
    }

    collectHashedFiles()
    {
        const hashesByRelativePath = {};

        const walk = (absoluteDirectory) =>
        {
            for (const entry of fs.readdirSync(absoluteDirectory, { withFileTypes: true }))
            {
                if (GenerateScriptIntegrityManifest.SKIPPED_DIRECTORY_NAMES.has(entry.name))
                {
                    continue;
                }

                const entryAbsolutePath = path.join(absoluteDirectory, entry.name);

                if (entry.isDirectory())
                {
                    walk(entryAbsolutePath);
                    continue;
                }

                if (!GenerateScriptIntegrityManifest.HASHED_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
                {
                    continue;
                }

                // Forward slashes regardless of platform: the manifest is written
                // on a developer's Windows machine and verified on a Linux
                // server, and a backslash key would match nothing there.
                const relativePath = path
                    .relative(this.staticDirectory, entryAbsolutePath)
                    .split(path.sep)
                    .join('/');

                hashesByRelativePath[relativePath] = GenerateScriptIntegrityManifest.hashFileContents(fs.readFileSync(entryAbsolutePath));
            }
        };

        walk(this.staticDirectory);

        return hashesByRelativePath;
    }

    run()
    {
        if (!fs.existsSync(this.staticDirectory))
        {
            console.error('[GenerateScriptIntegrityManifest] Dock/Static does not exist — run the build first.');
            process.exitCode = 1;
            return;
        }

        const hashesByRelativePath = this.collectHashedFiles();
        const sortedRelativePaths = Object.keys(hashesByRelativePath).sort();

        const manifest =
        {
            algorithm: GenerateScriptIntegrityManifest.HASH_ALGORITHM,
            generatedAt: new Date().toISOString(),
            fileCount: sortedRelativePaths.length,
            // Sorted so the manifest is byte-stable across builds of identical
            // input — a diff should mean the OUTPUT changed, not that the
            // filesystem enumerated in a different order.
            files: sortedRelativePaths.reduce((accumulated, relativePath) =>
            {
                accumulated[relativePath] = hashesByRelativePath[relativePath];
                return accumulated;
            }, {})
        };

        fs.writeFileSync(this.manifestFilePath, `${JSON.stringify(manifest, null, 4)}\n`, 'utf8');

        console.log(`Wrote ${GenerateScriptIntegrityManifest.MANIFEST_RELATIVE_PATH} — ${sortedRelativePaths.length} executable files hashed with ${GenerateScriptIntegrityManifest.HASH_ALGORITHM}.`);
    }
}

module.exports = GenerateScriptIntegrityManifest;

if (require.main === module)
{
    new GenerateScriptIntegrityManifest(path.join(__dirname, '..', '..')).run();
}
