const path = require('path');

const CommandRunner = require('./CommandRunner');

// The single, mandatory build. Every run mode (web, production, desktop, android, ios) runs this
// first, so the aggressive bundle + private-member mangle + minify/obfuscate is ALWAYS applied —
// there is no non-aggressive build path. The step ordering is identical to what the production
// deploy performs (Common/Deployment/deploy.sh build_frontend), so a dev build and a deploy build
// produce byte-identical Dock/Static artifacts.
class BuildPipeline
{
    // scriptName + extra CLI arguments, in the exact order they must run.
    static ORDERED_BUILD_STEPS = [
        { scriptName: 'GenerateServiceManifest.js', argumentList: [] },
        { scriptName: 'GenerateEnumerations.js', argumentList: [] },
        { scriptName: 'GenerateConstants.js', argumentList: [] },
        { scriptName: 'GenerateClasses.js', argumentList: [] },
        { scriptName: 'CopyStaticFiles.js', argumentList: [] },
        { scriptName: 'BundleStaticFiles.js', argumentList: [] },
        { scriptName: 'ManglePrivateMembersInBundle.js', argumentList: [] },
        { scriptName: 'MinifyAndObfuscateStaticFiles.js', argumentList: ['--aggressive'] },
    ];

    constructor()
    {
        this.scriptsDirectory = __dirname;
        this.repositoryRootDirectory = path.join(__dirname, '..', '..');
        this.commonDirectory = path.join(__dirname, '..');
    }

    run()
    {
        console.log('Running the aggressive build (codegen + copy + bundle + mangle + obfuscate) ...');

        CommandRunner.ensureDependencies(this.commonDirectory);

        for (const buildStep of BuildPipeline.ORDERED_BUILD_STEPS)
        {
            const scriptAbsolutePath = path.join(this.scriptsDirectory, buildStep.scriptName);
            CommandRunner.runNodeScript(scriptAbsolutePath, buildStep.argumentList, this.repositoryRootDirectory);
        }

        console.log('Aggressive build complete. Dock/Static is production-ready.');
    }
}

module.exports = BuildPipeline;
