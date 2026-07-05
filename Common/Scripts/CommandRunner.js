const childProcess = require('child_process');
const fileSystem = require('fs');
const path = require('path');

// Small, platform-agnostic wrapper around child_process.spawnSync used by every launcher and
// build script in this directory. It inherits stdio (so build/server output streams straight to
// the terminal), and it fails fast: any non-zero exit aborts the whole run with the child's code.
//
// runCommand uses shell: true so that "npm" / "tauri" resolve to their ".cmd" shims on Windows
// and to the plain binaries elsewhere without the caller having to know the difference. Node
// scripts are launched through process.execPath directly, so they never depend on how "node" is
// spelled on the PATH.
class CommandRunner
{
    static runNodeScript(scriptAbsolutePath, argumentList, workingDirectory)
    {
        const resolvedArguments = argumentList === undefined ? [] : argumentList;
        const resolvedWorkingDirectory = workingDirectory === undefined ? process.cwd() : workingDirectory;

        const result = childProcess.spawnSync(process.execPath, [scriptAbsolutePath, ...resolvedArguments], {
            cwd: resolvedWorkingDirectory,
            stdio: 'inherit',
        });

        CommandRunner.assertSuccess(result, `node ${path.basename(scriptAbsolutePath)} ${resolvedArguments.join(' ')}`.trim());
    }

    static runCommand(command, argumentList, workingDirectory)
    {
        const resolvedArguments = argumentList === undefined ? [] : argumentList;
        const resolvedWorkingDirectory = workingDirectory === undefined ? process.cwd() : workingDirectory;

        const result = childProcess.spawnSync(command, resolvedArguments, {
            cwd: resolvedWorkingDirectory,
            stdio: 'inherit',
            shell: true,
        });

        CommandRunner.assertSuccess(result, `${command} ${resolvedArguments.join(' ')}`.trim());
    }

    static ensureDependencies(directory)
    {
        const nodeModulesDirectory = path.join(directory, 'node_modules');

        if (fileSystem.existsSync(nodeModulesDirectory))
        {
            return;
        }

        console.log(`Installing dependencies in ${directory} ...`);
        CommandRunner.runCommand('npm', ['install'], directory);
    }

    static assertSuccess(result, description)
    {
        if (result.error !== undefined && result.error !== null)
        {
            console.error(`Failed to run: ${description}`);
            console.error(result.error);
            process.exit(1);
        }

        if (result.status !== 0)
        {
            const exitCode = result.status === null ? 1 : result.status;
            console.error(`Command exited with code ${exitCode}: ${description}`);
            process.exit(exitCode);
        }
    }
}

module.exports = CommandRunner;
