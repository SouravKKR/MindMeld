const path = require("path");
const { spawn } = require("child_process");
const { getPythonExecutablePathFromVenv } = require("../../UtilityFunctions.js/GetPythonExecutablePathFromVenv");

/**
 * RefinementProposalRunner — spawns the Python refinement workers and returns
 * what they proposed.
 *
 * Dock holds no AI code, so this is the same buffered subprocess shim
 * GeneratePaidDeckField uses: one JSON object down stdin, exactly one JSON line
 * back on stdout, stderr tee'd to the server log.
 *
 * It PROPOSES and never writes. Nothing this class returns has touched the
 * database; a separate endpoint applies it, and only after a person compared it
 * against what is there today. That split is the point of the whole feature —
 * an AI that both decides and writes is not a review gate with an assistant, it
 * is an autopilot with a progress bar.
 *
 * The visual worker gets a much longer timeout than the text one. It drives the
 * deck pipeline's own diagram path: a premium symbolic-generation call at high
 * reasoning effort, possibly a second one when the routed format declines and
 * the request escalates to inline SVG, then a rasterisation and a premium vision
 * review of the result. Timing that against a single flash-lite text call would
 * kill it in the middle of the work it was asked to do.
 */
class RefinementProposalRunner
{
    static TEXT_WORKER_TIMEOUT_MILLISECONDS = 120 * 1000;
    static VISUAL_WORKER_TIMEOUT_MILLISECONDS = 300 * 1000;

    // The TAIL of the worker's stderr, not the head: the diagnosis is whatever
    // it said last, and the head is import chatter. Capped so a worker having a
    // bad day cannot push a megabyte per failure into the log store.
    static #MAXIMUM_ATTACHED_STANDARD_ERROR_CHARACTERS = 4000;

    static #TEXT_WORKER_RELATIVE_PATH = ["Workflows", "RefineContent", "RefineContent.py"];
    static #VISUAL_WORKER_RELATIVE_PATH = ["Workflows", "RefineVisual", "RefineVisual.py"];

    /**
     * Runs the text refinement worker.
     * @return {Promise<{revisedHtml: string, summary: string, concerns: string, consultedUrls: string[], modelIdentifier: string}>}
     */
    static async proposeContentRevision(workerRequest)
    {
        return await RefinementProposalRunner.#runWorker(
            RefinementProposalRunner.#TEXT_WORKER_RELATIVE_PATH,
            workerRequest,
            RefinementProposalRunner.TEXT_WORKER_TIMEOUT_MILLISECONDS,
        );
    }

    /**
     * Runs the diagram refinement worker.
     * @return {Promise<{revisedHtml: string, summary: string, concerns: string, visionReviewOutcome: string, visualMethod: string, modelIdentifier: string}>}
     */
    static async proposeVisualRevision(workerRequest)
    {
        return await RefinementProposalRunner.#runWorker(
            RefinementProposalRunner.#VISUAL_WORKER_RELATIVE_PATH,
            workerRequest,
            RefinementProposalRunner.VISUAL_WORKER_TIMEOUT_MILLISECONDS,
        );
    }

    static #runWorker(workerRelativePath, stdinPayload, timeoutMilliseconds)
    {
        const agentServicePath = process.env.AGENT_SERVICE_PATH || path.join(__dirname, "../../../..", "Agent");
        const pythonInterpreterPath = getPythonExecutablePathFromVenv(path.join(agentServicePath, ".venv"));
        const workerScriptPath = path.join(agentServicePath, ...workerRelativePath);

        // Forward our own run mode so the worker's EnvironmentLoader loads the
        // matching environment file (.env on --debug, .production.env without
        // it) and therefore finds the Vertex AI auth.
        const runModeArguments = process.argv.includes("--debug") ? ["--debug"] : [];

        return new Promise((resolve, reject) =>
        {
            // The worker imports Globals.* — it MUST be spawned with cwd at the
            // Agent root so its sys.path bootstrap picks them up.
            const childProcess = spawn(
                pythonInterpreterPath,
                [workerScriptPath, ...runModeArguments],
                {
                    cwd: agentServicePath,
                    stdio: ["pipe", "pipe", "pipe"],
                    env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" },
                },
            );

            let stdoutBuffer = "";
            let stderrBuffer = "";
            let bSettled = false;

            const settle = (settler, value) =>
            {
                if (bSettled)
                {
                    return;
                }
                bSettled = true;
                settler(value);
            };

            const timeoutHandle = setTimeout(() =>
            {
                childProcess.kill("SIGKILL");
                settle(reject, new Error(`Refinement worker timed out after ${timeoutMilliseconds}ms.`));
            }, timeoutMilliseconds);

            childProcess.stdout.on("data", (chunk) =>
            {
                stdoutBuffer += chunk.toString();
            });

            childProcess.stderr.on("data", (chunk) =>
            {
                stderrBuffer += chunk.toString();
            });

            childProcess.on("error", (spawnError) =>
            {
                clearTimeout(timeoutHandle);
                settle(reject, new Error(`Failed to spawn refinement worker: ${spawnError.message}`));
            });

            // The shared automation stack (ResponseCache, ShadowModelEvaluator)
            // can print stray diagnostics to stdout, so the result is not assumed
            // to be the last line — scan upward for the last line that parses as
            // one of ours.
            const extractResultObject = () =>
            {
                const outputLines = stdoutBuffer.split("\n").map(line => line.trim()).filter(line => line.length > 0);

                for (let lineIndex = outputLines.length - 1; lineIndex >= 0; lineIndex -= 1)
                {
                    try
                    {
                        const candidate = JSON.parse(outputLines[lineIndex]);
                        if (candidate && typeof candidate === "object"
                            && (typeof candidate.revisedHtml === "string" || typeof candidate.error === "string"))
                        {
                            return candidate;
                        }
                    }
                    catch (parseError)
                    {
                        // Not our JSON line — keep scanning upward.
                    }
                }

                return null;
            };

            childProcess.on("close", (exitCode) =>
            {
                clearTimeout(timeoutHandle);

                const parsedOutput = extractResultObject();

                if (parsedOutput === null)
                {
                    const trimmedStderr = stderrBuffer.trim().slice(0, 1000);
                    settle(reject, new Error(`Refinement worker exited with code ${exitCode} and no parseable output. stderr: ${trimmedStderr}`));
                    return;
                }

                if (typeof parsedOutput.error === "string")
                {
                    // The worker's own message, not a stack trace. It is written
                    // for the reviewer ("the redrawn diagram did not pass visual
                    // review: the angles are unlabelled") and is surfaced as-is.
                    const workerFailure = new Error(parsedOutput.error);

                    // The worker's stderr carries WHY — the reply length, its
                    // first few hundred characters, the retry chatter. It used
                    // to be discarded on exactly this path, which is why a
                    // recurring production failure left no evidence anywhere and
                    // had to be diagnosed by reading the source. Attached rather
                    // than folded into the message, so the reviewer still sees
                    // the sentence written for them and the server log gets the
                    // diagnosis.
                    workerFailure.workerStandardError = stderrBuffer
                        .trim()
                        .slice(-RefinementProposalRunner.#MAXIMUM_ATTACHED_STANDARD_ERROR_CHARACTERS);

                    settle(reject, workerFailure);
                    return;
                }

                settle(resolve, parsedOutput);
            });

            // Writing to a worker that died between spawn and now surfaces an
            // EPIPE on the stdin stream — a separate channel from the child's own
            // 'error' event — so handle it here too rather than letting it escape
            // as an uncaughtException.
            childProcess.stdin.on("error", (stdinError) =>
            {
                clearTimeout(timeoutHandle);
                settle(reject, new Error(`Failed to write to refinement worker stdin: ${stdinError.message}`));
            });

            // write()/end() can also throw SYNCHRONOUSLY (ERR_STREAM_DESTROYED)
            // when the child died between spawn and now — catch it so the timeout
            // is cleared on that path too rather than leaking a timer.
            try
            {
                childProcess.stdin.write(JSON.stringify(stdinPayload));
                childProcess.stdin.end();
            }
            catch (writeError)
            {
                clearTimeout(timeoutHandle);
                settle(reject, new Error(`Failed to write to refinement worker stdin: ${writeError.message}`));
            }
        });
    }
}

module.exports = RefinementProposalRunner;
