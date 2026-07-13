const path = require('path');

const CommandRunner = require('./CommandRunner');
const BuildPipeline = require('./BuildPipeline');

// "npm run production" — the LOCAL production run. Builds the frontend (always aggressive), then
// starts the Dock server WITHOUT --debug, exactly as the base node's systemd unit does. This is
// the dev-box equivalent of the deployed server; the base-node/systemd deploy path is unchanged
// (see Common/ReadmeFiles/Deployment.md).
//
// Running without --debug is what enables distributed/queue mode when DOCK_USE_TASK_QUEUE=1, so a
// local production run behaves like the real server. Requires Redis on 127.0.0.1:6379.
class ProductionRunner
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

        console.log('Starting Dock in PRODUCTION mode on http://localhost:3000 ...');
        CommandRunner.runNodeScript(path.join(this.dockDirectory, 'index.js'), [], this.dockDirectory);
    }
}

new ProductionRunner().run();
