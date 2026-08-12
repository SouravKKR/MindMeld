// Turns the installers `tauri build` produced into the update manifest an
// installed app reads.
//
// WHY THIS IS A SCRIPT AND NOT A HAND-WRITTEN FILE. The manifest carries a
// signature that must correspond exactly to the bytes it points at. Written by
// hand, the failure mode is silent and total: the manifest publishes, every
// installed app fetches it, the signature does not verify against the download,
// and the update fails for all of them with no signal at this end. Deriving
// both from the same directory, in one pass, removes the opportunity.
//
// Usage:
//   node Common/Scripts/BuildDesktopUpdateManifest.js --domain learn.cogniumlabs.io --output <dir>
//
// Exits 3 when there is nothing to publish, which is NOT a failure — most
// deploys are frontend-only and never touch the desktop app. The caller
// distinguishes that from a real error by the code.

const fileSystem = require("fs");
const path = require("path");

class DesktopUpdateManifestBuilder
{
    // Tauri's own platform keys. The app looks itself up by this exact string,
    // so a typo produces "no update available" forever rather than an error.
    static WINDOWS_PLATFORM_KEY = "windows-x86_64";

    // Nothing to publish. Distinct from a failure so the deploy can carry on.
    static NOTHING_TO_PUBLISH_EXIT_CODE = 3;

    constructor(repositoryRootDirectory, publicDomain, outputDirectory)
    {
        this.repositoryRootDirectory = repositoryRootDirectory;
        this.publicDomain = publicDomain;
        this.outputDirectory = outputDirectory;
        this.bundleDirectory = path.join(
            repositoryRootDirectory, "Native", "src-tauri", "target", "release", "bundle"
        );
        this.configurationPath = path.join(
            repositoryRootDirectory, "Native", "src-tauri", "tauri.conf.json"
        );
    }

    build()
    {
        const declaredVersion = this.#readDeclaredVersion();
        const installer = this.#findWindowsInstaller();

        if (installer === null)
        {
            console.log("[DesktopUpdateManifest] No Windows installer has been built — nothing to publish.");
            return DesktopUpdateManifestBuilder.NOTHING_TO_PUBLISH_EXIT_CODE;
        }

        // A bundle directory accumulates every version ever built here —
        // `tauri build` never removes the previous one. Publishing the newest
        // FILE while the configuration declares a different version would ship
        // an installer whose contents disagree with the version the app is told
        // it is getting: it would install, report the old version, and be
        // offered the same update forever.
        if (!installer.fileName.includes(declaredVersion))
        {
            console.error(`[DesktopUpdateManifest] The newest installer is "${installer.fileName}" but tauri.conf.json declares ${declaredVersion}.`);
            console.error("[DesktopUpdateManifest] Rebuild the app so the two agree, rather than publishing a mismatch.");
            return 1;
        }

        const signature = this.#readSignature(installer.filePath);
        if (signature === null)
        {
            console.error(`[DesktopUpdateManifest] "${installer.fileName}" has no .sig beside it, so it was built without the signing key.`);
            console.error("[DesktopUpdateManifest] Every installed app verifies the signature against its baked-in public key and would refuse this.");
            console.error("[DesktopUpdateManifest] Rebuild with TAURI_SIGNING_PRIVATE_KEY and TAURI_SIGNING_PRIVATE_KEY_PASSWORD set.");
            return 1;
        }

        const manifest =
        {
            version: declaredVersion,
            notes: this.#readReleaseNotes(declaredVersion),
            // Fixed to the installer's own build time rather than "now", so
            // re-running this without rebuilding produces an identical manifest
            // instead of a new one that merely looks newer.
            pub_date: new Date(installer.modifiedAtMilliseconds).toISOString(),
            platforms:
            {
                [DesktopUpdateManifestBuilder.WINDOWS_PLATFORM_KEY]:
                {
                    signature: signature,
                    url: `https://${this.publicDomain}/DesktopUpdates/${installer.fileName}`,
                }
            }
        };

        fileSystem.mkdirSync(this.outputDirectory, { recursive: true });

        const manifestPath = path.join(this.outputDirectory, "latest.json");
        fileSystem.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

        const stagedInstallerPath = path.join(this.outputDirectory, installer.fileName);
        fileSystem.copyFileSync(installer.filePath, stagedInstallerPath);

        console.log(`[DesktopUpdateManifest] Staged ${installer.fileName} (${(installer.sizeBytes / 1048576).toFixed(1)} MB) and latest.json for ${declaredVersion}.`);
        console.log(`[DesktopUpdateManifest] Download URL: ${manifest.platforms[DesktopUpdateManifestBuilder.WINDOWS_PLATFORM_KEY].url}`);
        return 0;
    }

    #readDeclaredVersion()
    {
        const configuration = JSON.parse(fileSystem.readFileSync(this.configurationPath, "utf8"));
        if (typeof configuration.version !== "string" || configuration.version.length === 0)
        {
            throw new Error("tauri.conf.json declares no version.");
        }
        return configuration.version;
    }

    /**
     * The most recently built Windows installer.
     *
     * By modification time rather than by name: version strings do not sort
     * usefully as text once a component reaches double digits, and the
     * directory holds every build ever made here.
     */
    #findWindowsInstaller()
    {
        const nsisDirectory = path.join(this.bundleDirectory, "nsis");
        if (!fileSystem.existsSync(nsisDirectory))
        {
            return null;
        }

        const candidates = fileSystem.readdirSync(nsisDirectory)
            .filter((fileName) => fileName.toLowerCase().endsWith("-setup.exe"))
            .map((fileName) =>
            {
                const filePath = path.join(nsisDirectory, fileName);
                const fileStatistics = fileSystem.statSync(filePath);
                return {
                    fileName: fileName,
                    filePath: filePath,
                    sizeBytes: fileStatistics.size,
                    modifiedAtMilliseconds: fileStatistics.mtimeMs,
                };
            })
            .sort((first, second) => second.modifiedAtMilliseconds - first.modifiedAtMilliseconds);

        return candidates.length > 0 ? candidates[0] : null;
    }

    #readSignature(installerPath)
    {
        const signaturePath = `${installerPath}.sig`;
        if (!fileSystem.existsSync(signaturePath))
        {
            return null;
        }

        const signature = fileSystem.readFileSync(signaturePath, "utf8").trim();
        return signature.length > 0 ? signature : null;
    }

    /**
     * What the learner is told they are getting.
     *
     * Read from Common/ReleaseNotes/<version>.txt when it exists. The fallback
     * is deliberately plain rather than a generated changelog: commit subjects
     * are written for the people maintaining this, and pasting them into a
     * dialog aimed at a learner reads as noise.
     */
    #readReleaseNotes(version)
    {
        const notesPath = path.join(this.repositoryRootDirectory, "Common", "ReleaseNotes", `${version}.txt`);
        if (fileSystem.existsSync(notesPath))
        {
            return fileSystem.readFileSync(notesPath, "utf8").trim();
        }
        return `CogniumLearn ${version}`;
    }
}

function parseArguments(argumentList)
{
    const parsed = { domain: "", output: "" };

    for (let argumentIndex = 0; argumentIndex < argumentList.length; argumentIndex++)
    {
        if (argumentList[argumentIndex] === "--domain")
        {
            parsed.domain = argumentList[argumentIndex + 1] || "";
            argumentIndex++;
        }
        else if (argumentList[argumentIndex] === "--output")
        {
            parsed.output = argumentList[argumentIndex + 1] || "";
            argumentIndex++;
        }
    }

    return parsed;
}

const parsedArguments = parseArguments(process.argv.slice(2));

if (parsedArguments.domain.length === 0 || parsedArguments.output.length === 0)
{
    console.error("Usage: node BuildDesktopUpdateManifest.js --domain <host> --output <directory>");
    process.exit(1);
}

const builder = new DesktopUpdateManifestBuilder(
    path.resolve(__dirname, "..", ".."),
    parsedArguments.domain,
    parsedArguments.output
);

try
{
    process.exit(builder.build());
}
catch (buildError)
{
    console.error(`[DesktopUpdateManifest] ${buildError.message}`);
    process.exit(1);
}
