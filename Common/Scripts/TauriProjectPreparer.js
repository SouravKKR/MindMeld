const path = require('path');

const CommandRunner = require('./CommandRunner');
const BuildPipeline = require('./BuildPipeline');
const ConfigureTauriApp = require('./ConfigureTauriApp');

// Shared preparation for every Tauri build mode (desktop, android, ios). It runs the mandatory
// aggressive build (rule: no non-aggressive build path exists — this also keeps Dock/Static and
// the codegen current for a co-located web run), applies the env-driven Tauri configuration, and
// makes sure the Tauri CLI dependencies are installed.
class TauriProjectPreparer
{
    constructor()
    {
        this.repositoryRootDirectory = path.join(__dirname, '..', '..');
        this.buildTemplateDirectory = path.join(this.repositoryRootDirectory, 'Build', 'Template');
    }

    prepare()
    {
        new BuildPipeline().run();
        new ConfigureTauriApp().run();
        CommandRunner.ensureDependencies(this.buildTemplateDirectory);
    }
}

module.exports = TauriProjectPreparer;
