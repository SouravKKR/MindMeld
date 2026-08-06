const path = require('path');

const CommandRunner = require('./CommandRunner');
const BuildFreshness = require('./BuildFreshness');

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
        // LAST, always: it records the hashes of the final served bytes, so it
        // has to run after obfuscation rewrites them. Moving it earlier would
        // bake in hashes of files that no longer exist in that form, and every
        // boot would then report tampering that never happened.
        { scriptName: 'GenerateScriptIntegrityManifest.js', argumentList: [] },
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

    // Used by the run modes (web, production, desktop, android, ios): build only when a
    // build input changed since the last successful build, otherwise skip straight to
    // starting the server. `npm run setup` calls run() directly and always rebuilds.
    // Set COGNIUMLEARN_FORCE_BUILD=1 to force a rebuild from any entry point.
    runIfStale()
    {
        const buildFreshness = new BuildFreshness(this.repositoryRootDirectory);

        if ((process.env.COGNIUMLEARN_FORCE_BUILD || '').trim() !== '')
        {
            console.log('COGNIUMLEARN_FORCE_BUILD is set — rebuilding regardless of freshness.');
        }
        else if (buildFreshness.isBuildUpToDate())
        {
            console.log('Frontend is already built and no build inputs changed since the last build — skipping the build.');
            return;
        }

        this.run();

        // Record the post-build state (codegen may have regenerated deterministic
        // files) so the next run compares against it and can skip.
        buildFreshness.writeStoredSignature(buildFreshness.computeInputSignature());
    }
}

module.exports = BuildPipeline;
