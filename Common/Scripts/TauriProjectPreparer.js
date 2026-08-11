const childProcess = require('child_process');
const path = require('path');

const CommandRunner = require('./CommandRunner');
const BuildPipeline = require('./BuildPipeline');
const ConfigureTauriApp = require('./ConfigureTauriApp');

// Shared preparation for every Tauri build mode (desktop, android, ios). It runs the mandatory
// aggressive build (rule: no non-aggressive build path exists — this also keeps Dock/Static and
// the codegen current for a co-located web run), applies the env-driven Tauri configuration, and
// makes sure the Tauri CLI dependencies are installed.
//
// It also decides whether this machine can build the on-device inference engine, which is a Cargo
// feature rather than a default because it compiles llama.cpp from source and needs CMake and
// libclang. Deciding here rather than in each runner means desktop, android and ios cannot drift
// apart on the question.
class TauriProjectPreparer
{
    static NATIVE_INFERENCE_FEATURE_NAME = 'native-inference';

    // Set to any non-empty value to build the shell without the inference engine — a faster build,
    // and the escape hatch when a toolchain problem would otherwise block shipping a fix. The app
    // still works: its capability probe reports no native runtime and the frontend uses its
    // browser execution path.
    static SKIP_FEATURE_ENVIRONMENT_VARIABLE = 'COGNIUMLEARN_SKIP_NATIVE_INFERENCE';

    constructor()
    {
        this.repositoryRootDirectory = path.join(__dirname, '..', '..');
        this.nativeProjectDirectory = path.join(this.repositoryRootDirectory, 'Native');
    }

    prepare()
    {
        new BuildPipeline().runIfStale();
        new ConfigureTauriApp().run();
        CommandRunner.ensureDependencies(this.nativeProjectDirectory);
    }

    /**
     * The extra `tauri build` arguments that switch the inference engine on, or an empty list.
     *
     * Reported rather than silently decided: a build that quietly produced an app with no
     * on-device model would look identical to one that did, right up until a learner picked the
     * Free tier and was told their device is unsupported.
     */
    resolveFeatureArguments()
    {
        const skipRequest = process.env[TauriProjectPreparer.SKIP_FEATURE_ENVIRONMENT_VARIABLE];
        if (skipRequest !== undefined && skipRequest.trim().length > 0)
        {
            console.log(`Skipping the on-device inference engine (${TauriProjectPreparer.SKIP_FEATURE_ENVIRONMENT_VARIABLE} is set).`);
            return [];
        }

        if (!TauriProjectPreparer.isLibclangAvailable())
        {
            console.warn('libclang was not found, so the on-device inference engine will NOT be built into this app.');
            console.warn('  It is needed to generate the bindings to llama.cpp. Install LLVM (winget install LLVM.LLVM),');
            console.warn('  or set LIBCLANG_PATH to the directory holding libclang, then rebuild.');
            return [];
        }

        console.log('Building with the on-device inference engine.');
        return ['--features', TauriProjectPreparer.NATIVE_INFERENCE_FEATURE_NAME];
    }

    /**
     * Whether bindgen will find libclang.
     *
     * Asked by running the real detector — `clang --version` — rather than by probing a list of
     * paths this script would have to keep in step with every platform's packaging. LIBCLANG_PATH
     * wins when it is set, because that is what bindgen itself honours.
     */
    static isLibclangAvailable()
    {
        if (process.env.LIBCLANG_PATH !== undefined && process.env.LIBCLANG_PATH.trim().length > 0)
        {
            return true;
        }

        const detectionResult = childProcess.spawnSync('clang', ['--version'], { shell: true, stdio: 'ignore' });
        return detectionResult.error === undefined && detectionResult.status === 0;
    }
}

module.exports = TauriProjectPreparer;
