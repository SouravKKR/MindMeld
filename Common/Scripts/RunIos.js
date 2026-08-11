const fileSystem = require('fs');
const path = require('path');

const CommandRunner = require('./CommandRunner');
const TauriProjectPreparer = require('./TauriProjectPreparer');

// "npm run ios" — build and run the app on iOS via Tauri. iOS builds require macOS + Xcode, so on
// any other platform this prints a clear message and exits cleanly (the scaffolding is in place;
// it just has to be run on a Mac). The app loads the production site and caches pages offline, and
// registers the same service worker — note that WKWebView only honours service workers for
// App-Bound Domains, so the production domain must be declared in the iOS project's Info.plist
// (WKAppBoundDomains) for offline caching to work on Apple platforms.
class IosRunner
{
    constructor()
    {
        this.repositoryRootDirectory = path.join(__dirname, '..', '..');
        this.nativeProjectDirectory = path.join(this.repositoryRootDirectory, 'Native');
        this.appleGeneratedDirectory = path.join(this.nativeProjectDirectory, 'src-tauri', 'gen', 'apple');
    }

    run()
    {
        if (process.platform !== 'darwin')
        {
            console.log('iOS builds require macOS with Xcode installed. The iOS scaffolding is in place — run "npm run ios" on a Mac to build and deploy.');
            return;
        }

        new TauriProjectPreparer().prepare();

        if (fileSystem.existsSync(this.appleGeneratedDirectory) === false)
        {
            console.log('Initializing the iOS project (first run) ...');
            CommandRunner.runCommand('npm', ['run', 'tauri', '--', 'ios', 'init'], this.nativeProjectDirectory);
        }

        console.log('Building and deploying to the iOS target ...');
        CommandRunner.runCommand('npm', ['run', 'tauri', '--', 'ios', 'dev'], this.nativeProjectDirectory);
    }
}

new IosRunner().run();
