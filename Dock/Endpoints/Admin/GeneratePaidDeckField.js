const { spawn } = require("child_process");
const path = require("path");
const Logger = require("../../Globals/Classes/Logger");
const { getPythonExecutablePathFromVenv } = require("../../Globals/UtilityFunctions.js/GetPythonExecutablePathFromVenv");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");

/**
 * GeneratePaidDeckField
 *
 * Admin-only "AI generate field" helper for the paid-deck upload / edit
 * dialogs. Dock holds no AI code, so this is a thin, buffered cousin of
 * AskAiStreamRunner: it spawns the one-shot Python worker
 * (Agent/Workflows/GeneratePaidDeckField/GeneratePaidDeckField.py),
 * writes the generation context to its stdin, waits for the single JSON
 * line it writes to stdout, and returns the generated text.
 *
 * Unlike AskAi this is NOT a metered feature — it is gated to admins by
 * the ensureAdmin plugin on the route, so there is no credit preflight
 * or charge.
 */
class GeneratePaidDeckField
{
    static ALLOWED_FIELDS = new Set(["title", "category", "description", "tags"]);

    static MAX_STUDY_MATERIAL_TITLES = 300;
    static MAX_DECK_CHAIN_ENTRIES = 24;
    static MAX_FIELD_VALUE_CHARS = 4096;
    static WORKER_TIMEOUT_MILLISECONDS = 60 * 1000;

    static #clampString(rawValue)
    {
        return String(rawValue ?? "").slice(0, GeneratePaidDeckField.MAX_FIELD_VALUE_CHARS);
    }

    static #sanitizeStringArray(rawValue, maximumEntries)
    {
        if (!Array.isArray(rawValue))
        {
            return [];
        }

        const sanitized = [];
        for (const entry of rawValue)
        {
            const text = GeneratePaidDeckField.#clampString(entry).trim();
            if (text.length > 0)
            {
                sanitized.push(text);
            }
            if (sanitized.length >= maximumEntries)
            {
                break;
            }
        }
        return sanitized;
    }

    static #sanitizeExistingMetadata(rawValue)
    {
        const sanitized = {};
        if (!rawValue || typeof rawValue !== "object")
        {
            return sanitized;
        }

        for (const fieldKey of GeneratePaidDeckField.ALLOWED_FIELDS)
        {
            if (typeof rawValue[fieldKey] === "string")
            {
                sanitized[fieldKey] = GeneratePaidDeckField.#clampString(rawValue[fieldKey]);
            }
        }
        return sanitized;
    }

    /**
     * Spawns the Python worker and resolves with the parsed JSON object
     * it prints on stdout ({ text } or { error }). Rejects on spawn
     * failure, timeout, non-zero exit, or unparseable output.
     */
    static #runWorker(stdinPayload)
    {
        const agentServicePath = process.env.AGENT_SERVICE_PATH || path.join(__dirname, "../../..", "Agent");
        const pythonInterpreterPath = getPythonExecutablePathFromVenv(path.join(agentServicePath, ".venv"));
        const workerScriptPath = path.join(agentServicePath, "Workflows", "GeneratePaidDeckField", "GeneratePaidDeckField.py");

        // Forward our own run mode so the worker's EnvironmentLoader loads
        // the matching environment file (.env on --debug, .production.env
        // without it) and therefore finds GEMINI_API_KEY.
        const runModeArguments = process.argv.includes("--debug") ? ["--debug"] : [];

        return new Promise((resolve, reject) =>
        {
            // The worker imports Globals.* — it MUST be spawned with cwd at
            // the Agent root so its sys.path bootstrap picks them up.
            const childProcess = spawn(
                pythonInterpreterPath,
                [workerScriptPath, ...runModeArguments],
                {
                    cwd: agentServicePath,
                    stdio: ["pipe", "pipe", "pipe"],
                    env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" }
                }
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
                settle(reject, new Error(`Worker timed out after ${GeneratePaidDeckField.WORKER_TIMEOUT_MILLISECONDS}ms.`));
            }, GeneratePaidDeckField.WORKER_TIMEOUT_MILLISECONDS);

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
                settle(reject, new Error(`Failed to spawn worker: ${spawnError.message}`));
            });

            // The shared automation stack (ResponseCache, ShadowModelEvaluator)
            // can print stray diagnostics to stdout, so we don't assume the
            // result is the very last line — instead scan upward for the last
            // line that parses as our result object ({ text } or { error }).
            const extractResultObject = () =>
            {
                const outputLines = stdoutBuffer.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
                for (let lineIndex = outputLines.length - 1; lineIndex >= 0; lineIndex -= 1)
                {
                    try
                    {
                        const candidate = JSON.parse(outputLines[lineIndex]);
                        if (candidate && typeof candidate === "object" && (typeof candidate.text === "string" || typeof candidate.error === "string"))
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
                    settle(reject, new Error(`Worker exited with code ${exitCode} and no parseable output. stderr: ${trimmedStderr}`));
                    return;
                }

                settle(resolve, parsedOutput);
            });

            // Writing to a worker that died between spawn and now surfaces an
            // EPIPE on the stdin stream (a separate channel from the child's
            // own 'error' event) — handle it so it can't escape as an
            // uncaughtException.
            childProcess.stdin.on("error", (stdinError) =>
            {
                clearTimeout(timeoutHandle);
                settle(reject, new Error(`Failed to write to worker stdin: ${stdinError.message}`));
            });

            // write()/end() can also throw SYNCHRONOUSLY (ERR_STREAM_DESTROYED)
            // when the child died between spawn and now — catch it so the
            // timeout is cleared on that path too rather than leaking a timer.
            try
            {
                childProcess.stdin.write(JSON.stringify(stdinPayload));
                childProcess.stdin.end();
            }
            catch (writeError)
            {
                clearTimeout(timeoutHandle);
                settle(reject, new Error(`Failed to write to worker stdin: ${writeError.message}`));
            }
        });
    }

    static async handle(request, response)
    {
        const body = await request.getBody();
        const field = typeof body?.field === "string" ? body.field.trim() : "";

        if (!GeneratePaidDeckField.ALLOWED_FIELDS.has(field))
        {
            response.statusCode = httpStatus.BAD_REQUEST;
            response.sendJson({ error: "Unsupported field." });
            return;
        }

        const stdinPayload =
        {
            field: field,
            studyMaterialTitles: GeneratePaidDeckField.#sanitizeStringArray(body?.studyMaterialTitles, GeneratePaidDeckField.MAX_STUDY_MATERIAL_TITLES),
            deckChain: GeneratePaidDeckField.#sanitizeStringArray(body?.deckChain, GeneratePaidDeckField.MAX_DECK_CHAIN_ENTRIES),
            existingMetadata: GeneratePaidDeckField.#sanitizeExistingMetadata(body?.existingMetadata)
        };

        let workerOutput;
        try
        {
            workerOutput = await GeneratePaidDeckField.#runWorker(stdinPayload);
        }
        catch (workerError)
        {
            Logger.log(`[GeneratePaidDeckField] Worker failure: ${workerError.message}`, "DOCK");
            response.statusCode = httpStatus.BAD_GATEWAY;
            response.sendJson({ error: "Generation service is unavailable. Please try again." });
            return;
        }

        if (typeof workerOutput.text !== "string" || workerOutput.text.length === 0)
        {
            const workerErrorMessage = typeof workerOutput.error === "string" ? workerOutput.error : "Generation failed.";
            Logger.log(`[GeneratePaidDeckField] Worker reported: ${workerErrorMessage}`, "DOCK");
            response.statusCode = httpStatus.BAD_GATEWAY;
            response.sendJson({ error: "Could not generate text for this field. Please try again." });
            return;
        }

        response.statusCode = httpStatus.OK;
        response.sendJson({ text: workerOutput.text });
    }
}

async function generatePaidDeckField(request, response)
{
    return GeneratePaidDeckField.handle(request, response);
}

module.exports = { generatePaidDeckField, GeneratePaidDeckField };
