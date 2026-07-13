const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Decides whether the aggressive frontend build can be skipped because none of its
// inputs changed since the last successful build. The run modes (web, production,
// desktop, android, ios) consult this so an unchanged tree starts the server
// immediately instead of paying for a full codegen + bundle + obfuscate pass.
//
// The signature is a hash of every build-input file's relative path, size and
// modification time — a pure stat walk, so it stays fast even though Main/ contains
// large third-party assets. It is stored after each successful build and compared on
// the next run. `npm run setup` never consults this (it is the explicit "always
// rebuild" command), and MINDMELD_FORCE_BUILD forces a rebuild from any entry point.
class BuildFreshness
{
    // Everything the build reads. Generated mirrors (Dock/Globals, Agent/Globals,
    // Dock/Static) are OUTPUTS and are intentionally NOT listed. Main/ is listed
    // whole because that is where frontend source is edited; its codegen-generated
    // files are deterministic, so re-listing them causes no spurious rebuilds.
    static INPUT_RELATIVE_PATHS = [
        'Main',
        'Common/Enumerations',
        'Common/Constants',
        'Common/Classes',
        'Common/Scripts',
        'Common/ServiceManifest.json',
    ];

    static MANIFEST_RELATIVE_PATH = '.build-manifest.json';

    static SKIPPED_DIRECTORY_NAMES = new Set(['node_modules', '.git']);

    constructor(repositoryRootDirectory)
    {
        this.repositoryRootDirectory = repositoryRootDirectory;
        this.manifestFilePath        = path.join(repositoryRootDirectory, BuildFreshness.MANIFEST_RELATIVE_PATH);
        this.staticOutputDirectory   = path.join(repositoryRootDirectory, 'Dock', 'Static');
    }

    computeInputSignature()
    {
        const entries = [];

        const walk = (absolutePath) =>
        {
            const stats = fs.statSync(absolutePath);
            if (stats.isDirectory())
            {
                for (const childName of fs.readdirSync(absolutePath))
                {
                    if (BuildFreshness.SKIPPED_DIRECTORY_NAMES.has(childName))
                    {
                        continue;
                    }
                    walk(path.join(absolutePath, childName));
                }
                return;
            }

            const relativePath = path.relative(this.repositoryRootDirectory, absolutePath).split(path.sep).join('/');
            entries.push(`${relativePath}|${stats.size}|${Math.floor(stats.mtimeMs)}`);
        };

        for (const inputRelativePath of BuildFreshness.INPUT_RELATIVE_PATHS)
        {
            const inputAbsolutePath = path.join(this.repositoryRootDirectory, inputRelativePath);
            if (fs.existsSync(inputAbsolutePath))
            {
                walk(inputAbsolutePath);
            }
        }

        entries.sort();

        const hash = crypto.createHash('sha1');
        hash.update(entries.join('\n'));
        return hash.digest('hex');
    }

    readStoredSignature()
    {
        if (!fs.existsSync(this.manifestFilePath))
        {
            return null;
        }

        try
        {
            const parsed = JSON.parse(fs.readFileSync(this.manifestFilePath, 'utf8'));
            return typeof parsed.signature === 'string' ? parsed.signature : null;
        }
        catch (parseError)
        {
            void parseError;
            return null;
        }
    }

    writeStoredSignature(signature)
    {
        fs.writeFileSync(this.manifestFilePath, JSON.stringify({ signature }, null, 2), 'utf8');
    }

    hasBuildOutput()
    {
        if (!fs.existsSync(this.staticOutputDirectory))
        {
            return false;
        }
        return fs.readdirSync(this.staticOutputDirectory).some((name) => name.toLowerCase().endsWith('.js'));
    }

    isBuildUpToDate()
    {
        if (!this.hasBuildOutput())
        {
            return false;
        }

        const storedSignature = this.readStoredSignature();
        if (storedSignature === null)
        {
            return false;
        }

        return storedSignature === this.computeInputSignature();
    }
}

module.exports = BuildFreshness;
