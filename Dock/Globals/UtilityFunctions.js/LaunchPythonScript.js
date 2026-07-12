const { spawn } = require("child_process");
const path = require("path");

/**
 * Launch a Python script as a subprocess.
 *
 * @param {string} pythonInterpreterPath
 * @param {string} scriptPath
 * @param {string[]} commandLineArguments
 * @param {(stream: 'stdout'|'stderr', line: string) => void} [onLine]
 *        Optional per-line callback invoked as the child emits output. When provided,
 *        stdout/stderr are streamed line-by-line in addition to being buffered for the
 *        final result.
 * @param {number} [maxDurationMilliseconds]
 *        Optional hard ceiling on the child's lifetime. When > 0, a child that has
 *        not exited by then is terminated (SIGTERM, then SIGKILL) and the promise
 *        rejects, so a wedged child can never block the caller forever. 0 (default)
 *        disables the timeout, leaving every existing caller's behaviour unchanged.
 */
function launchPythonScript(pythonInterpreterPath, scriptPath, commandLineArguments = [], onLine = null, maxDurationMilliseconds = 0)
{
    return new Promise((resolve, reject) =>
    {
        const workingDirectory = path.dirname(scriptPath);

        const child = spawn(
            pythonInterpreterPath,
            [scriptPath, ...commandLineArguments],
            { cwd: workingDirectory }
        );

        let stdoutAll = "";
        let stderrAll = "";
        let stdoutTail = "";
        let stderrTail = "";

        // Backstop timeout: kill a child that never exits (e.g. a wedged
        // interpreter shutdown) so the caller's await rejects instead of hanging.
        // SIGTERM first, then a SIGKILL a few seconds later if it is ignored. The
        // timers are cleared the moment the child closes or errors on its own.
        let killTimer = null;
        let forceKillTimer = null;

        const clearTimers = () =>
        {
            if (killTimer !== null) { clearTimeout(killTimer); killTimer = null; }
            if (forceKillTimer !== null) { clearTimeout(forceKillTimer); forceKillTimer = null; }
        };

        if (maxDurationMilliseconds > 0)
        {
            killTimer = setTimeout(() =>
            {
                try { child.kill("SIGTERM"); } catch (terminateError) { /* already gone */ }
                forceKillTimer = setTimeout(() =>
                {
                    try { child.kill("SIGKILL"); } catch (forceKillError) { /* already gone */ }
                }, 5000);
                reject(new Error(`Python script exceeded ${maxDurationMilliseconds}ms and was terminated: ${scriptPath}`));
            }, maxDurationMilliseconds);
        }

        const consume = (chunk, streamName) =>
        {
            const text = chunk.toString("utf-8");
            if (streamName === "stdout") stdoutAll += text; else stderrAll += text;

            if (!onLine) return;

            let buffer = (streamName === "stdout" ? stdoutTail : stderrTail) + text;
            const lines = buffer.split(/\r?\n/);
            const tail = lines.pop();
            if (streamName === "stdout") stdoutTail = tail; else stderrTail = tail;

            for (const line of lines) onLine(streamName, line);
        };

        child.stdout.on("data", (d) => consume(d, "stdout"));
        child.stderr.on("data", (d) => consume(d, "stderr"));

        child.on("close", (code) =>
        {
            clearTimers();
            if (onLine)
            {
                if (stdoutTail) onLine("stdout", stdoutTail);
                if (stderrTail) onLine("stderr", stderrTail);
            }

            if (code === 0)
            {
                resolve({ stdout: stdoutAll, stderr: stderrAll, exitCode: code });
            }
            else
            {
                reject(new Error(`Exit code ${code}\n${stderrAll}`));
            }
        });

        child.on("error", (error) => { clearTimers(); reject(error); });
    });
}

module.exports = { launchPythonScript };
