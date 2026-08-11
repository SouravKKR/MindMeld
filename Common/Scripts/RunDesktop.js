const childProcess = require('child_process');
const fileSystem = require('fs');
const path = require('path');

const CommandRunner = require('./CommandRunner');
const TauriProjectPreparer = require('./TauriProjectPreparer');

// "npm run desktop" — build the native desktop app, install it via its OS installer, then launch
// it. `tauri build` recompiles incrementally, so only changed code is rebuilt ("install if any
// changes, then run"). The app itself loads the production site and caches pages for offline use.
class DesktopRunner
{
    static PRODUCT_BINARY_BASENAME = 'cognium-learn';

    constructor()
    {
        this.repositoryRootDirectory = path.join(__dirname, '..', '..');
        this.nativeProjectDirectory = path.join(this.repositoryRootDirectory, 'Native');
        this.releaseDirectory = path.join(this.nativeProjectDirectory, 'src-tauri', 'target', 'release');
        this.bundleDirectory = path.join(this.releaseDirectory, 'bundle');
    }

    run()
    {
        const preparer = new TauriProjectPreparer();
        preparer.prepare();

        console.log('Building the desktop app (tauri build) ...');
        CommandRunner.runCommand(
            'npm',
            ['run', 'tauri', '--', 'build', ...preparer.resolveFeatureArguments()],
            this.nativeProjectDirectory
        );

        this.installAndLaunch();
    }

    installAndLaunch()
    {
        if (process.platform === 'win32')
        {
            this.installAndLaunchWindows();
        }
        else if (process.platform === 'darwin')
        {
            this.installAndLaunchMac();
        }
        else
        {
            this.installAndLaunchLinux();
        }
    }

    // Return the most recently modified matching file, not merely the first one readdir yields.
    // `tauri build` never deletes previous-version bundles, so after a version bump the bundle
    // directory holds both the stale and the freshly built installer; picking by newest mtime
    // guarantees we install the build we just produced instead of an older leftover.
    findNewestFile(directory, matchesPredicate)
    {
        if (fileSystem.existsSync(directory) === false)
        {
            return null;
        }

        let newestFilePath = null;
        let newestModifiedTime = -1;

        for (const entryName of fileSystem.readdirSync(directory))
        {
            if (matchesPredicate(entryName) === false)
            {
                continue;
            }

            const candidatePath = path.join(directory, entryName);
            const modifiedTime = fileSystem.statSync(candidatePath).mtimeMs;

            if (modifiedTime > newestModifiedTime)
            {
                newestModifiedTime = modifiedTime;
                newestFilePath = candidatePath;
            }
        }

        return newestFilePath;
    }

    launchDetached(executablePath, argumentList)
    {
        const child = childProcess.spawn(executablePath, argumentList === undefined ? [] : argumentList, {
            detached: true,
            stdio: 'ignore',
        });
        child.unref();
    }

    installAndLaunchWindows()
    {
        const nsisSetupPath = this.findNewestFile(path.join(this.bundleDirectory, 'nsis'), (name) => name.toLowerCase().endsWith('.exe'));
        const msiInstallerPath = this.findNewestFile(path.join(this.bundleDirectory, 'msi'), (name) => name.toLowerCase().endsWith('.msi'));

        if (nsisSetupPath !== null)
        {
            console.log(`Installing ${path.basename(nsisSetupPath)} silently ...`);
            CommandRunner.runCommand(`"${nsisSetupPath}"`, ['/S'], this.bundleDirectory);
        }
        else if (msiInstallerPath !== null)
        {
            console.log(`Installing ${path.basename(msiInstallerPath)} silently ...`);
            CommandRunner.runCommand('msiexec', ['/i', `"${msiInstallerPath}"`, '/qn'], this.bundleDirectory);
        }
        else
        {
            console.warn('No NSIS/MSI installer was found under the bundle directory; launching the built binary directly.');
        }

        const executablePath = path.join(this.releaseDirectory, `${DesktopRunner.PRODUCT_BINARY_BASENAME}.exe`);

        if (fileSystem.existsSync(executablePath) === false)
        {
            console.error(`Built executable not found at ${executablePath}.`);
            process.exit(1);
        }

        console.log('Launching CogniumLearn ...');
        this.launchDetached(executablePath);
    }

    installAndLaunchMac()
    {
        // The .app bundle is the installable unit on macOS; "open" launches it directly.
        const applicationBundlePath = this.findNewestFile(path.join(this.bundleDirectory, 'macos'), (name) => name.toLowerCase().endsWith('.app'));

        if (applicationBundlePath === null)
        {
            console.error('No .app bundle was found under the bundle directory.');
            process.exit(1);
        }

        console.log(`Launching ${path.basename(applicationBundlePath)} ...`);
        CommandRunner.runCommand('open', [`"${applicationBundlePath}"`], this.bundleDirectory);
    }

    installAndLaunchLinux()
    {
        const appImagePath = this.findNewestFile(path.join(this.bundleDirectory, 'appimage'), (name) => name.toLowerCase().endsWith('.appimage'));

        if (appImagePath !== null)
        {
            console.log(`Launching ${path.basename(appImagePath)} ...`);
            try
            {
                fileSystem.chmodSync(appImagePath, 0o755);
            }
            catch (chmodError)
            {
                void chmodError;
            }
            this.launchDetached(appImagePath);
            return;
        }

        const executablePath = path.join(this.releaseDirectory, DesktopRunner.PRODUCT_BINARY_BASENAME);

        if (fileSystem.existsSync(executablePath) === false)
        {
            console.error('No AppImage or built binary was found to launch.');
            process.exit(1);
        }

        console.log('Launching CogniumLearn ...');
        this.launchDetached(executablePath);
    }
}

new DesktopRunner().run();
