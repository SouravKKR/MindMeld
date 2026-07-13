const path = require('path');

const CommandRunner = require('./CommandRunner');
const BuildPipeline = require('./BuildPipeline');

// "npm run web" — the developer web mode. Builds the frontend (always aggressive), then starts
// the Dock server with --debug (verbose Logger output, local task subprocesses). Dock is launched
// with the Dock directory as its working directory so dotenv loads Dock/.env.
//
// Note: Dock's boot path requires Redis on 127.0.0.1:6379 (TaskManager.initialize) — start Redis
// before running this. Serves http://localhost:3000.
class WebRunner
{
    constructor()
    {
        this.repositoryRootDirectory = path.join(__dirname, '..', '..');
        this.dockDirectory = path.join(this.repositoryRootDirectory, 'Dock');
    }

    run()
    {
        new BuildPipeline().runIfStale();

        CommandRunner.ensureDependencies(this.dockDirectory);

        console.log('Starting Dock in WEB (debug) mode on http://localhost:3000 ...');
        CommandRunner.runNodeScript(path.join(this.dockDirectory, 'index.js'), ['--debug'], this.dockDirectory);
    }
}

new WebRunner().run();
