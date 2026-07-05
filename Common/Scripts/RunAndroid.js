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
        this.buildTemplateDirectory = path.join(this.repositoryRootDirectory, 'Build', 'Template');
        this.androidGeneratedDirectory = path.join(this.buildTemplateDirectory, 'src-tauri', 'gen', 'android');
    }

    run()
    {
        new TauriProjectPreparer().prepare();

        if (fileSystem.existsSync(this.androidGeneratedDirectory) === false)
        {
            console.log('Initializing the Android project (first run) ...');
            CommandRunner.runCommand('npm', ['run', 'tauri', '--', 'android', 'init'], this.buildTemplateDirectory);
        }

        console.log('Building and deploying to the connected Android device ...');
        CommandRunner.runCommand('npm', ['run', 'tauri', '--', 'android', 'dev'], this.buildTemplateDirectory);
    }
}

new AndroidRunner().run();
