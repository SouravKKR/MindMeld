const crypto = require("crypto");
const { spawn } = require("child_process");
const readline = require("readline");
const path = require("path");
const Logger = require("../../../Globals/Classes/Logger");
const { getPythonExecutablePathFromVenv } = require("../../../Globals/UtilityFunctions.js/GetPythonExecutablePathFromVenv");
const { httpStatus } = require("../../../Globals/Enumerations/HttpStatus");
const { creditTransactionTypes } = require("../../../Globals/Enumerations/CreditTransactionTypes");
const { taskTypes } = require("../../../Globals/Enumerations/TaskTypes");
const CreditPreflight = require("../../../Globals/Classes/Credits/CreditPreflight");
const CreditLedger = require("../../../Globals/Classes/Credits/CreditLedger");
const CreditConfigurationStore = require("../../../Globals/Classes/Credits/CreditConfigurationStore");
const MaintenanceGate = require("../../../Globals/Classes/Maintenance/MaintenanceGate");
const PlanEntitlementGate = require("../../../Globals/Classes/Plans/PlanEntitlementGate");
const { planFeatures } = require("../../../Globals/Enumerations/PlanFeatures");

/**
 * AutoFillOptionsRunner
 *
 * Buffered subprocess shim for the "Auto Fill Other Options" generation helper.
 * Mirrors AskAiStreamRunner: Dock holds no AI code, it spawns the Agent Python
 * worker, feeds the request body to its stdin, and reads the worker's NDJSON
 * back off stdout. Unlike AskAi this is NOT streamed to the browser — the worker
 * emits a single {"type":"result","options":{…}} line and Dock replies with one
 * JSON object.
 *
 * Credit metering matches AskAi: this helper is NOT a queued Workflow, so the
 * Agent's task charging hooks never see it. The runner therefore meters it
 * directly — a CreditPreflight check before the worker is spawned (402 when the
 * user cannot afford it) and an idempotent CreditLedger charge when the worker
 * completes cleanly (a "result" event with no preceding "error" event).
 */
class AutoFillOptionsRunner
{
    static #SUBJECT_NAME_MAX_CHARS = 400;
    static #FREE_TEXT_MAX_CHARS = 4000;
    static #VALID_MODES = new Set(["SIMPLE", "ADVANCED", "TEMPLATE"]);
    // A buffered request never streams, so a hung worker would otherwise hold the
    // socket open until the edge times out. Kill it ourselves after this long.
    static #WORKER_TIMEOUT_MILLISECONDS = 90 * 1000;

    static async run({ userId, request, response })
    {
        // The handler resolves the user before calling us; a missing id here means
        // a wiring bug, not a client mistake — refuse rather than run an
        // unattributable (and therefore unchargeable) Gemini call.
        if (typeof userId !== "string" || userId.length === 0)
        {
            response.sendStatusCode(httpStatus.UNAUTHORIZED);
            return;
        }

        const activeMaintenanceWindow = await MaintenanceGate.getActiveWindow();
        if (activeMaintenanceWindow !== null)
        {
            response.statusCode = httpStatus.SERVICE_UNAVAILABLE;
            response.sendJson(MaintenanceGate.buildMaintenanceResponsePayload(activeMaintenanceWindow));
            return;
        }

        // Plan entitlement: auto-filling generation options is part of the
        // automatic-generation feature (Pro tier). Refuse a lower tier before
        // the credit preflight so it sees an upgrade prompt, not a 402.
        const autoFillEntitlement = await PlanEntitlementGate.requireFeature(userId, planFeatures.AUTOMATIC_GENERATION);
        if (!autoFillEntitlement.allowed)
        {
            response.statusCode = httpStatus.FORBIDDEN;
            response.sendJson({ error: autoFillEntitlement.reason, currentTier: autoFillEntitlement.currentTier, requiredTier: autoFillEntitlement.requiredTier });
            return;
        }

        const creditPreflight = await CreditPreflight.check(userId, taskTypes.AUTO_FILL_GENERATION_OPTIONS);
        if (!creditPreflight.allowed)
        {
            response.statusCode = httpStatus.PAYMENT_REQUIRED;
            response.sendJson({ error: creditPreflight.reason, balance: creditPreflight.balance, required: creditPreflight.required });
            return;
        }

        const requestBody = await AutoFillOptionsRunner.#readRequestBody(request);
        if (requestBody === null)
        {
            response.sendStatusCode(httpStatus.BAD_REQUEST);
            return;
        }

        const validationError = AutoFillOptionsRunner.#validate(requestBody);
        if (validationError !== null)
        {
            response.statusCode = httpStatus.BAD_REQUEST;
            response.end(validationError);
            return;
        }

        // One idempotency key per HTTP request: the close handler is the only
        // charge site, but the ledger's unique-referenceKey guard makes even an
        // unexpected double fire safe.
        const chargeReferenceKey = `autoFill:${userId}:${crypto.randomUUID()}`;

        const agentServicePath = process.env.AGENT_SERVICE_PATH || path.join(__dirname, "../../../..", "Agent");
        const pythonInterpreterPath = getPythonExecutablePathFromVenv(path.join(agentServicePath, ".venv"));
        const workerScriptPath = path.join(agentServicePath, "Workflows", "AutoFillGenerationOptions", "AutoFillGenerationOptions.py");

        // Forward our own run mode so the worker loads the matching environment file
        // (EnvironmentLoader picks .env on --debug, .production.env without it).
        const runModeArguments = process.argv.includes("--debug") ? ["--debug"] : [];

        const childProcess = spawn(
            pythonInterpreterPath,
            [workerScriptPath, ...runModeArguments],
            {
                cwd: agentServicePath,
                stdio: ["pipe", "pipe", "pipe"],
                env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" },
            }
        );

        // userId rides along for attribution in the worker's logs; the
        // authoritative charge happens here in Dock on clean completion.
        const stdinPayload =
        {
            ...requestBody,
            userId: userId,
        };

        // A worker that dies between spawn and write turns the stdin pipe into an
        // EPIPE source; guard the synchronous write and listen for the async error
        // so neither becomes an unhandled exception. A failed write just means the
        // worker gets no input — it then exits and the close handler returns 500.
        childProcess.stdin.on("error", (stdinError) =>
        {
            Logger.log(`[AutoFill] worker stdin error: ${stdinError.message}`, "DOCK");
        });
        try
        {
            childProcess.stdin.write(JSON.stringify(stdinPayload));
            childProcess.stdin.end();
        }
        catch (stdinWriteError)
        {
            Logger.log(`[AutoFill] failed to write worker stdin: ${stdinWriteError.message}`, "DOCK");
        }

        let capturedOptions = null;
        let bErrorEmitted = false;
        let bResponseSent = false;

        // The single send site for the whole request. Guarded by bResponseSent so
        // it fires exactly once across the timeout / spawn-error / close paths, and
        // wrapped in try/catch so a write to a connection the client already closed
        // can never throw. Deliberately does NOT consult any "client gone" flag:
        // for a buffered reply the only reply happens here at the end, so a client
        // disconnect must not be allowed to suppress it.
        const sendOnce = (statusCode, payload) =>
        {
            if (bResponseSent)
            {
                return;
            }
            bResponseSent = true;
            try
            {
                response.statusCode = statusCode;
                response.sendJson(payload);
            }
            catch (sendError)
            {
                Logger.log(`[AutoFill] failed to send response: ${sendError.message}`, "DOCK");
            }
        };

        const stdoutLineReader = readline.createInterface({ input: childProcess.stdout });
        stdoutLineReader.on("line", (workerOutputLine) =>
        {
            if (workerOutputLine.length === 0)
            {
                return;
            }
            try
            {
                const parsedEvent = JSON.parse(workerOutputLine);
                if (parsedEvent && parsedEvent.type === "result")
                {
                    capturedOptions = (parsedEvent.options && typeof parsedEvent.options === "object") ? parsedEvent.options : {};
                }
                if (parsedEvent && parsedEvent.type === "error")
                {
                    bErrorEmitted = true;
                    Logger.log(`[AutoFill] worker error: ${parsedEvent.message || "(no message)"}`, "DOCK");
                }
            }
            catch (parseError)
            {
                // Non-JSON lines shouldn't happen in steady state — ignore them.
            }
        });

        const stderrLineReader = readline.createInterface({ input: childProcess.stderr });
        stderrLineReader.on("line", (stderrLine) =>
        {
            if (stderrLine.length === 0) return;
            Logger.log(`[AutoFill worker] ${stderrLine}`, "AGENT:AUTO_FILL");
        });

        // Safety timeout: a buffered request can't stream, so a hung worker would
        // pin the socket open. Kill it and fail the request. This is also the only
        // bound on worker lifetime if the client disconnects mid-call — the worker
        // is short-lived (a single flash-lite call), so we let it finish (or hit
        // this timeout) rather than racing a disconnect signal whose firing time
        // is unreliable for a JSON-body request.
        const workerTimeout = setTimeout(() =>
        {
            if (childProcess.exitCode === null)
            {
                try { childProcess.kill("SIGTERM"); }
                catch (killError) { Logger.log(`[AutoFill] timeout kill failed: ${killError.message}`, "DOCK"); }
            }
            sendOnce(httpStatus.INTERNAL_SERVER_ERROR, { error: "AUTO_FILL_FAILED" });
        }, AutoFillOptionsRunner.#WORKER_TIMEOUT_MILLISECONDS);

        childProcess.on("error", (spawnError) =>
        {
            clearTimeout(workerTimeout);
            Logger.log(`[AutoFill] worker spawn error: ${spawnError.message}`, "DOCK");
            sendOnce(httpStatus.INTERNAL_SERVER_ERROR, { error: "AUTO_FILL_FAILED" });
        });

        childProcess.on("close", async (exitCode) =>
        {
            clearTimeout(workerTimeout);
            stdoutLineReader.close();
            stderrLineReader.close();

            // Charge only a clean completion — a "result" event arrived with no
            // preceding "error" event.
            if (capturedOptions !== null && !bErrorEmitted)
            {
                AutoFillOptionsRunner.#chargeForCompletedTask(userId, chargeReferenceKey)
                    .catch((chargeError) => Logger.log(`[AutoFill] credit charge failed for ${chargeReferenceKey}: ${chargeError.message}`, "DOCK"));

                sendOnce(httpStatus.OK, { options: capturedOptions });
                return;
            }

            Logger.log(`[AutoFill] worker produced no usable result (exit ${exitCode}, error=${bErrorEmitted}).`, "DOCK");
            sendOnce(httpStatus.INTERNAL_SERVER_ERROR, { error: "AUTO_FILL_FAILED" });
        });
    }

    /**
     * Reads the JSON body via the PacketronHandlerFlags.JSON_BODY-parsed accessor,
     * falling back to a raw read if a future caller invokes us without the flag.
     * Returns null on malformed JSON.
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
            Logger.log(`[AutoFill] failed to read body: ${readError.message}`, "DOCK");
            return null;
        }
    }

    /**
     * Returns null when the body is well-formed, otherwise a short human-readable
     * reason. subjectName is the one field the model genuinely needs; the rest are
     * optional context with generous size caps to catch obvious abuse only.
     */
    static #validate(requestBody)
    {
        if (typeof requestBody !== "object" || requestBody === null)
        {
            return "Body must be a JSON object.";
        }

        const subjectName = typeof requestBody.subjectName === "string" ? requestBody.subjectName.trim() : "";
        if (subjectName.length === 0)
        {
            return "subjectName is required.";
        }
        if (subjectName.length > AutoFillOptionsRunner.#SUBJECT_NAME_MAX_CHARS)
        {
            return `subjectName exceeds ${AutoFillOptionsRunner.#SUBJECT_NAME_MAX_CHARS} chars.`;
        }

        if (!AutoFillOptionsRunner.#VALID_MODES.has(requestBody.mode))
        {
            return "mode must be one of SIMPLE / ADVANCED / TEMPLATE.";
        }

        if (requestBody.enabledArtifacts !== undefined && (typeof requestBody.enabledArtifacts !== "object" || requestBody.enabledArtifacts === null))
        {
            return "enabledArtifacts must be an object when provided.";
        }

        for (const fieldName of ["examName", "description", "additionalInstructions"])
        {
            const fieldValue = requestBody[fieldName];
            if (fieldValue !== undefined && fieldValue !== null)
            {
                if (typeof fieldValue !== "string")
                {
                    return `${fieldName} must be a string.`;
                }
                if (fieldValue.length > AutoFillOptionsRunner.#FREE_TEXT_MAX_CHARS)
                {
                    return `${fieldName} exceeds ${AutoFillOptionsRunner.#FREE_TEXT_MAX_CHARS} chars.`;
                }
            }
        }

        return null;
    }

    /**
     * Deducts the configured flat cost after a clean completion. Like AskAi this
     * is the authoritative charge — the helper bypasses the task queue so no
     * Agent-side hook would otherwise meter it. A rule that has gone missing or
     * been disabled since the preflight simply results in no charge.
     * @param {string} userId
     * @param {string} referenceKey — per-request idempotency key
     */
    static async #chargeForCompletedTask(userId, referenceKey)
    {
        const configuration = await CreditConfigurationStore.load();
        const rule = configuration.getRuleForTask(taskTypes.AUTO_FILL_GENERATION_OPTIONS);
        if (rule === null || !rule.getEnabled())
        {
            return;
        }

        const chargeAmount = rule.evaluate({});
        if (chargeAmount <= 0)
        {
            return;
        }

        const chargeResult = await CreditLedger.charge
        (
            userId,
            chargeAmount,
            creditTransactionTypes.TASK_CHARGE,
            referenceKey,
            { taskType: taskTypes.AUTO_FILL_GENERATION_OPTIONS, source: "AutoFillGenerationOptions" },
            rule.getMinimumBalanceFloor()
        );

        if (chargeResult.rejected)
        {
            Logger.log(`[AutoFill] charge of ${chargeAmount} rejected by balance floor for user ${userId} (${referenceKey}).`, "DOCK");
        }
    }
}

module.exports = AutoFillOptionsRunner;
