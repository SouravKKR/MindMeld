const fileSystem = require('fs');
const path = require('path');

const CommandRunner = require('./CommandRunner');
const TauriProjectPreparer = require('./TauriProjectPreparer');

// "npm run android" — build and run the app on a USB-connected Android device via Tauri. The app
// loads the production site and caches pages for offline use, exactly like the desktop build.
// Requires the Android SDK + NDK to be installed and ANDROID_HOME / NDK_HOME configured; if they
// are missing the Tauri CLI prints a precise diagnostic.
class AndroidRunner
{
    constructor()
    {
        this.repositoryRootDirectory = path.join(__dirname, '..', '..');
        this.nativeProjectDirectory = path.join(this.repositoryRootDirectory, 'Native');
        this.androidGeneratedDirectory = path.join(this.nativeProjectDirectory, 'src-tauri', 'gen', 'android');
    }

    run()
    {
        const preparer = new TauriProjectPreparer();
        preparer.prepare();

        if (fileSystem.existsSync(this.androidGeneratedDirectory) === false)
        {
            console.log('Initializing the Android project (first run) ...');
            CommandRunner.runCommand('npm', ['run', 'tauri', '--', 'android', 'init'], this.nativeProjectDirectory);
        }

        console.log('Building and deploying to the connected Android device ...');
        CommandRunner.runCommand(
            'npm',
            ['run', 'tauri', '--', 'android', 'dev', ...preparer.resolveFeatureArguments()],
            this.nativeProjectDirectory
        );
    }
}

new AndroidRunner().run();
