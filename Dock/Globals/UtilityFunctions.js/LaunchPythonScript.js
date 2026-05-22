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
 */
function launchPythonScript(pythonInterpreterPath, scriptPath, commandLineArguments = [], onLine = null)
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

        child.on("error", (error) => reject(error));
    });
}

module.exports = { launchPythonScript };
