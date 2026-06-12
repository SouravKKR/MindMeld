const { spawn } = require("child_process");
const readline = require("readline");
const path = require("path");
const Logger = require("../../../Globals/Classes/Logger");
const { getPythonExecutablePathFromVenv } = require("../../../Globals/UtilityFunctions.js/GetPythonExecutablePathFromVenv");
const {httpStatus} = require("../../../Globals/Enumerations/HttpStatus");

/**
 * AskAiStreamRunner
 *
 * Thin streaming shim — Dock holds no AI code, just spawns the AskAi
 * Python worker, feeds the request body to its stdin, and forwards each
 * NDJSON line the worker writes to stdout as a chunked HTTP write to
 * the browser. Dock never parses Gemini events — it's a byte pipe with
 * a body validator and an admin gate.
 *
 * The per-tier handlers (QueryBasic / QueryPro / QueryProPlus) all call
 * `AskAiStreamRunner.run(...)` with their model id + grounding flag.
 * Those two fields are the ONLY thing that differs between tiers, so the
 * runner stays a single class instead of three near-identical copies.
 */
class AskAiStreamRunner
{
    static #SELECTED_TEXT_MAX_CHARS = 4000;
    static #USER_QUERY_MAX_CHARS    = 2000;
    static #MAX_ATTACHED_IMAGES     = 4;
    static #MAX_IMAGE_BASE64_BYTES  = 8 * 1024 * 1024;
    static #MAX_INFORMATION_SOURCES = 8;

    static async run({ modelId, bEnableGoogleSearch, request, response })
    {
        const requestBody = await AskAiStreamRunner.#readRequestBody(request);
        if (requestBody === null)
        {
            response.sendStatusCode(400);
            return;
        }

        const validationError = AskAiStreamRunner.#validate(requestBody);
        if (validationError !== null)
        {
            response.statusCode = httpStatus.BAD_REQUEST;
            response.end(validationError);
            return;
        }

        const agentServicePath = process.env.AGENT_SERVICE_PATH || path.join(__dirname, "../../../..", "Agent");
        const pythonInterpreterPath = getPythonExecutablePathFromVenv(path.join(agentServicePath, ".venv"));
        const workerScriptPath = path.join(agentServicePath, "Workflows", "AskAi", "StreamAskAiResponse.py");

        // The worker reads PYTHONPATH-relative imports (Globals.*, Workflows.*) — it MUST
        // be spawned with cwd at the Agent root so its sys.path picks them up.
        const childProcess = spawn(
            pythonInterpreterPath,
            [workerScriptPath],
            {
                cwd: agentServicePath,
                stdio: ["pipe", "pipe", "pipe"],
                env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" },
            }
        );

        // Inject model + grounding flag into the payload Dock forwards on stdin.
        // The frontend never sends these — they're tier-locked server-side so a
        // tampered client can't ask for Pro Plus while hitting /Query/Basic.
        const stdinPayload =
        {
            ...requestBody,
            modelId: modelId,
            bEnableGoogleSearch: bEnableGoogleSearch,
        };

        childProcess.stdin.write(JSON.stringify(stdinPayload));
        childProcess.stdin.end();

        response.writeHead(200,
        {
            "Content-Type":      "text/plain; charset=utf-8",
            "Transfer-Encoding": "chunked",
            "Cache-Control":     "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        });
        if (typeof response.flushHeaders === "function")
        {
            response.flushHeaders();
        }

        let bDoneEmitted = false;
        let bResponseClosed = false;

        const stdoutLineReader = readline.createInterface({ input: childProcess.stdout });
        stdoutLineReader.on("line", (workerOutputLine) =>
        {
            if (bResponseClosed)
            {
                return;
            }
            if (workerOutputLine.length === 0)
            {
                return;
            }
            // Track the terminal "done" event so we can distinguish a
            // clean stream end from a crash on the close-event path.
            // Parse the line — substring matching is brittle against
            // whitespace variations (json.dumps emits `{"type": "done"}`
            // with a space after the colon, not `{"type":"done"}`).
            try
            {
                const parsedEvent = JSON.parse(workerOutputLine);
                if (parsedEvent && parsedEvent.type === "done")
                {
                    bDoneEmitted = true;
                }
            }
            catch (parseError)
            {
                // Non-JSON lines on stdout shouldn't happen in steady state,
                // but if they do we still forward verbatim — the frontend's
                // splitter will tolerate them (it skips malformed JSON lines).
            }
            response.write(workerOutputLine + "\n");
        });

        const stderrLineReader = readline.createInterface({ input: childProcess.stderr });
        stderrLineReader.on("line", (stderrLine) =>
        {
            if (stderrLine.length === 0) return;
            Logger.log(`[AskAi worker] ${stderrLine}`, "AGENT:ASK_AI");
        });

        // Browser disconnect → kill the worker so we don't keep generating
        // tokens for a closed socket. The capture-phase "close" event fires
        // on both client abort and natural completion; the bDoneEmitted +
        // exit-code logic below distinguishes the two.
        request.on("close", () =>
        {
            if (bResponseClosed) return;
            bResponseClosed = true;
            if (childProcess.exitCode === null)
            {
                try { childProcess.kill("SIGTERM"); }
                catch (killError) { Logger.log(`[AskAi] kill failed: ${killError.message}`, "DOCK"); }
            }
        });

        childProcess.on("error", (spawnError) =>
        {
            Logger.log(`[AskAi] worker spawn error: ${spawnError.message}`, "DOCK");
            if (!bResponseClosed)
            {
                response.write(JSON.stringify({ type: "error", message: "Failed to launch AskAi worker." }) + "\n");
                response.write('{"type":"done"}\n');
                bResponseClosed = true;
                response.end();
            }
        });

        childProcess.on("close", (exitCode) =>
        {
            stdoutLineReader.close();
            stderrLineReader.close();

            if (bResponseClosed) return;

            // The worker should always emit a {"type":"done"} sentinel before
            // exit. If it didn't (crash / OOM / signal), synthesise one plus
            // an error event so the client's stream reader doesn't hang.
            if (!bDoneEmitted)
            {
                response.write(JSON.stringify({ type: "error", message: `Worker terminated unexpectedly (exit ${exitCode}).` }) + "\n");
                response.write('{"type":"done"}\n');
            }

            bResponseClosed = true;
            response.end();
        });
    }

    /**
     * Reads the JSON body via the PacketronHandlerFlags.JSON_BODY-parsed
     * accessor when available; falls back to raw stream read if a future
     * caller invokes us without the flag. Returns null on malformed JSON.
     */
    static async #readRequestBody(request)
    {
        try
        {
            const parsedBody = await request.getBody();
            if (parsedBody === null || parsedBody === undefined)
            {
                return null;
            }
            if (typeof parsedBody === "string")
            {
                return JSON.parse(parsedBody);
            }
            return parsedBody;
        }
        catch (readError)
        {
            Logger.log(`[AskAi] failed to read body: ${readError.message}`, "DOCK");
            return null;
        }
    }

    /**
     * Returns null when the body is well-formed, otherwise a short
     * human-readable reason. Caps are deliberately generous — we want
     * to catch obvious abuse, not police every legitimate workflow.
     */
    static #validate(requestBody)
    {
        if (typeof requestBody !== "object" || requestBody === null)
        {
            return "Body must be a JSON object.";
        }

        const promptMode = requestBody.promptMode;
        const validPromptModes = new Set(["EXPLAIN", "ASK", "SUMMARIZE", "FORMAT", "MAKE_MNEMONIC", "GIVE_EXAMPLES", "GLOSSARY"]);
        if (!validPromptModes.has(promptMode))
        {
            return "promptMode must be one of EXPLAIN / ASK / SUMMARIZE / FORMAT / MAKE_MNEMONIC / GIVE_EXAMPLES / GLOSSARY.";
        }

        const contextKind = requestBody.contextKind;
        if (contextKind !== "CARD" && contextKind !== "STUDY_MATERIAL")
        {
            return "contextKind must be 'CARD' or 'STUDY_MATERIAL'.";
        }

        // selectedText is OPTIONAL — when empty/absent, the request acts on
        // the whole entity (the StudySessionBottomPanel's flow). When
        // present, it's a selection-scoped request from the
        // TextSelectionContextMenu. SUMMARIZE is always whole-entity, so
        // any selectedText passed in is ignored by the prompt builder.
        const selectedText = typeof requestBody.selectedText === "string" ? requestBody.selectedText : "";
        if (selectedText.length > AskAiStreamRunner.#SELECTED_TEXT_MAX_CHARS)
        {
            return `selectedText exceeds ${AskAiStreamRunner.#SELECTED_TEXT_MAX_CHARS} chars.`;
        }

        if (promptMode === "ASK")
        {
            const userQuery = requestBody.userQuery;
            if (typeof userQuery !== "string" || userQuery.length === 0)
            {
                return "userQuery is required when promptMode is 'ASK'.";
            }
            if (userQuery.length > AskAiStreamRunner.#USER_QUERY_MAX_CHARS)
            {
                return `userQuery exceeds ${AskAiStreamRunner.#USER_QUERY_MAX_CHARS} chars.`;
            }
        }

        const attachedImages = Array.isArray(requestBody.attachedImages) ? requestBody.attachedImages : [];
        if (attachedImages.length > AskAiStreamRunner.#MAX_ATTACHED_IMAGES)
        {
            return `Too many attached images (max ${AskAiStreamRunner.#MAX_ATTACHED_IMAGES}).`;
        }
        for (const attachedImage of attachedImages)
        {
            if (typeof attachedImage !== "object" || attachedImage === null) return "Malformed attached image entry.";
            if (typeof attachedImage.mimeType !== "string" || !attachedImage.mimeType.startsWith("image/")) return "Image mimeType must be image/*.";
            if (typeof attachedImage.base64Data !== "string" || attachedImage.base64Data.length === 0) return "Image base64Data missing.";
            if (attachedImage.base64Data.length > AskAiStreamRunner.#MAX_IMAGE_BASE64_BYTES) return "Image exceeds size cap.";
        }

        const informationSources = Array.isArray(requestBody.informationSources) ? requestBody.informationSources : [];
        if (informationSources.length > AskAiStreamRunner.#MAX_INFORMATION_SOURCES)
        {
            return `Too many information sources (max ${AskAiStreamRunner.#MAX_INFORMATION_SOURCES}).`;
        }

        return null;
    }
}

module.exports = AskAiStreamRunner;
