const crypto = require("crypto");
const { spawn } = require("child_process");
const readline = require("readline");
const path = require("path");
const Logger = require("../../../Globals/Classes/Logger");
const LogTitles = require("../../../Globals/Classes/Logging/LogTitles");
const { logCategory } = require("../../../Globals/Enumerations/LogCategory");
const { getPythonExecutablePathFromVenv } = require("../../../Globals/UtilityFunctions.js/GetPythonExecutablePathFromVenv");
const {httpStatus} = require("../../../Globals/Enumerations/HttpStatus");
const { creditTransactionTypes } = require("../../../Globals/Enumerations/CreditTransactionTypes");
const { askAiLanguages } = require("../../../Globals/Enumerations/AskAiLanguages");
const CreditPreflight = require("../../../Globals/Classes/Credits/CreditPreflight");
const CreditLedger = require("../../../Globals/Classes/Credits/CreditLedger");
const CreditConfigurationStore = require("../../../Globals/Classes/Credits/CreditConfigurationStore");
const MaintenanceGate = require("../../../Globals/Classes/Maintenance/MaintenanceGate");
const MetricBadgeManager = require("../../../Globals/Classes/Metrics/MetricBadgeManager");
const PlanEntitlementGate = require("../../../Globals/Classes/Plans/PlanEntitlementGate");
const InformationSourceQueryEngine = require("../../../Globals/Classes/Database/InformationSourceQueryEngine");
const { planFeatures } = require("../../../Globals/Enumerations/PlanFeatures");

/**
 * AskAiStreamRunner
 *
 * Thin streaming shim — Dock holds no AI code, just spawns the AskAi
 * Python worker, feeds the request body to its stdin, and forwards each
 * NDJSON line the worker writes to stdout as a chunked HTTP write to
 * the browser. Dock never parses Gemini events — it's a byte pipe with
 * a body validator and a credit meter.
 *
 * The per-tier handlers (QueryBasic / QueryPro / QueryProPlus) all call
 * `AskAiStreamRunner.run(...)` with their task type, model id and
 * grounding flag. Those three fields are the ONLY thing that differs
 * between tiers, so the runner stays a single class instead of three
 * near-identical copies.
 *
 * Credit metering: AskAi is NOT a queued Workflow, so the Agent's task
 * charging hooks never see it. The runner therefore meters it directly —
 * a CreditPreflight check before the worker is spawned (402 when the
 * user cannot afford the tier) and an idempotent CreditLedger charge
 * when the stream completes successfully (a "done" event with no
 * preceding "error" event).
 */
class AskAiStreamRunner
{
    static #SELECTED_TEXT_MAX_CHARS = 4000;
    static #USER_QUERY_MAX_CHARS    = 2000;
    static #MAX_ATTACHED_IMAGES     = 4;
    static #MAX_IMAGE_BASE64_BYTES  = 8 * 1024 * 1024;
    static #MAX_INFORMATION_SOURCES = 8;
    // Bounds the whole DECK chat contextPayload (client-retrieved snippets +
    // conversation history + deck-image ids) — generous, just catches abuse.
    static #DECK_CONTEXT_MAX_CHARS  = 200000;

    static async run({ taskType, userId, modelId, bEnableGoogleSearch, request, response })
    {
        // [ASKAI_TIMING] Instrumentation: mark the moment the request enters the
        // runner and stamp a short correlation tag onto both Dock's own log
        // lines and the worker's (injected via stdin). Reconstructing the tagged
        // lines from the server log shows exactly where AskAi latency goes:
        // Dock preflight -> worker spawn -> imports/env -> grounding -> web image
        // search -> prompt build -> Gemini time-to-first-token.
        const askAiRequestReceivedAt = Date.now();
        const askAiRequestTag = crypto.randomUUID().slice(0, 8);
        Logger.log(`[ASKAI_TIMING tag=${askAiRequestTag}] request received (task ${taskType}, user ${userId})`, "DOCK");

        // The handlers resolve the user before calling us; a missing id here
        // means a wiring bug, not a client mistake — refuse rather than run
        // an unattributable (and therefore unchargeable) Gemini call.
        if (typeof userId !== "string" || userId.length === 0)
        {
            response.sendStatusCode(httpStatus.UNAUTHORIZED);
            return;
        }

        // Scheduled-maintenance gate. Blocks STARTING a new AskAi query — an
        // already-streaming response is untouched.
        const activeMaintenanceWindow = await MaintenanceGate.getActiveWindow();
        if (activeMaintenanceWindow !== null)
        {
            response.statusCode = httpStatus.SERVICE_UNAVAILABLE;
            response.sendJson(MaintenanceGate.buildMaintenanceResponsePayload(activeMaintenanceWindow));
            return;
        }

        // Plan entitlement: Ask AI is available on every tier by default, but
        // the check is applied here too so an admin can restrict it via the
        // feature-access override. Refuse with FEATURE_NOT_IN_PLAN (403) before
        // the credit preflight when the tier does not include it.
        const askAiEntitlement = await PlanEntitlementGate.requireFeatureForRequest(request, userId, planFeatures.ASK_AI);
        if (!askAiEntitlement.allowed)
        {
            response.statusCode = httpStatus.FORBIDDEN;
            response.sendJson({ error: askAiEntitlement.reason, currentTier: askAiEntitlement.currentTier, requiredTier: askAiEntitlement.requiredTier });
            return;
        }

        const creditPreflight = await CreditPreflight.check(userId, taskType);
        if (!creditPreflight.allowed)
        {
            response.statusCode = httpStatus.PAYMENT_REQUIRED;
            response.sendJson({ error: creditPreflight.reason, balance: creditPreflight.balance, required: creditPreflight.required });
            return;
        }

        const requestBody = await AskAiStreamRunner.#readRequestBody(request);
        if (requestBody === null)
        {
            response.sendStatusCode(httpStatus.BAD_REQUEST);
            return;
        }

        const validationError = AskAiStreamRunner.#validate(requestBody);
        if (validationError !== null)
        {
            response.statusCode = httpStatus.BAD_REQUEST;
            response.end(validationError);
            return;
        }

        // Deck-level Chat is its own entitlement, checked here because it can
        // only be identified once the body is parsed — contextKind DECK is what
        // distinguishes a chat from an in-study Ask AI.
        //
        // Until now planFeatures.CHAT appeared in every tier's feature list and
        // was enforced nowhere, so an administrator (or an organization) that
        // switched chat off found it still working. Gating the cheap planning
        // call alone would not have been enough: the answer arrives through this
        // stream, and a client could simply skip the planner.
        if (requestBody.contextKind === "DECK")
        {
            const chatEntitlement = await PlanEntitlementGate.requireFeatureForRequest(request, userId, planFeatures.CHAT);
            if (!chatEntitlement.allowed)
            {
                response.statusCode = httpStatus.FORBIDDEN;
                response.sendJson({ error: chatEntitlement.reason, currentTier: chatEntitlement.currentTier, requiredTier: chatEntitlement.requiredTier });
                return;
            }
        }

        // One idempotency key per HTTP request: the close handler is the only
        // charge site and fires once per child process, but the ledger's
        // unique-referenceKey guard makes even an unexpected double fire safe.
        const chargeReferenceKey = `askAi:${taskType}:${userId}:${crypto.randomUUID()}`;

        const agentServicePath = process.env.AGENT_SERVICE_PATH || path.join(__dirname, "../../../..", "Agent");
        const pythonInterpreterPath = getPythonExecutablePathFromVenv(path.join(agentServicePath, ".venv"));
        const workerScriptPath = path.join(agentServicePath, "Workflows", "AskAi", "StreamAskAiResponse.py");

        // Forward our own run mode so the worker loads the matching environment
        // file (EnvironmentLoader picks .env on --debug, .production.env without
        // it). Without this the subprocess would always look like production.
        const runModeArguments = process.argv.includes("--debug") ? ["--debug"] : [];

        // The worker reads PYTHONPATH-relative imports (Globals.*, Workflows.*) — it MUST
        // be spawned with cwd at the Agent root so its sys.path picks them up.
        const askAiSpawnIssuedAt = Date.now();
        Logger.log(`[ASKAI_TIMING tag=${askAiRequestTag}] spawning worker (+${askAiSpawnIssuedAt - askAiRequestReceivedAt}ms: maintenance + credit preflight + body read/validate)`, "DOCK");
        const childProcess = spawn(
            pythonInterpreterPath,
            [workerScriptPath, ...runModeArguments],
            {
                cwd: agentServicePath,
                stdio: ["pipe", "pipe", "pipe"],
                env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" },
            }
        );

        // Inject model + grounding flag into the payload Dock forwards on stdin.
        // The frontend never sends these — they're tier-locked server-side so a
        // tampered client can't ask for Pro Plus while hitting /Query/Basic.
        // userId rides along for charge attribution in the worker's logs; the
        // authoritative charge itself happens here in Dock on stream completion.
        const stdinPayload =
        {
            ...requestBody,
            informationSources: await AskAiStreamRunner.#filterInformationSourcesToOwned(userId, requestBody.informationSources, askAiRequestTag),
            modelId: modelId,
            bEnableGoogleSearch: bEnableGoogleSearch,
            userId: userId,
            requestTag: askAiRequestTag,
            dockSpawnIssuedAtMs: askAiSpawnIssuedAt,
        };

        childProcess.stdin.write(JSON.stringify(stdinPayload));
        childProcess.stdin.end();

        response.writeHead(httpStatus.OK,
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
        let bErrorEmitted = false;
        let bResponseClosed = false;
        let bFirstWorkerOutputLogged = false;

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
            if (!bFirstWorkerOutputLogged)
            {
                bFirstWorkerOutputLogged = true;
                Logger.log(`[ASKAI_TIMING tag=${askAiRequestTag}] first worker stdout event (+${Date.now() - askAiSpawnIssuedAt}ms since spawn, +${Date.now() - askAiRequestReceivedAt}ms since received)`, "DOCK");
            }
            // Track the terminal "done" event so we can distinguish a
            // clean stream end from a crash on the close-event path, and
            // any "error" event so a failed stream is never charged.
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
                if (parsedEvent && parsedEvent.type === "error")
                {
                    bErrorEmitted = true;
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

        childProcess.on("close", async (exitCode) =>
        {
            stdoutLineReader.close();
            stderrLineReader.close();
            Logger.log(`[ASKAI_TIMING tag=${askAiRequestTag}] worker closed (exit ${exitCode}, +${Date.now() - askAiRequestReceivedAt}ms total since received)`, "DOCK");

            // Charge only a successful stream — the worker emitted its
            // "done" sentinel without any preceding "error" event. This
            // runs BEFORE the bResponseClosed early-return on purpose: a
            // client that disconnects after the final token has still
            // consumed the full Gemini call and must still be charged.
            if (bDoneEmitted && !bErrorEmitted)
            {
                AskAiStreamRunner.#chargeForCompletedStream(userId, taskType, chargeReferenceKey)
                    .catch((chargeError) => Logger.log(`[AskAi] credit charge failed for ${chargeReferenceKey}: ${chargeError.message}`, "DOCK"));

                // A completed stream IS a doubt asked. Count it authoritatively
                // here — server-side, so a client can't inflate it (every doubt
                // is a real, credit-metered call) — then stream the updated
                // metrics back so the client's count refreshes and any milestone
                // badge just crossed celebrates immediately. The client keeps
                // reading until response.end(), so this trailing line is received
                // even though the worker's "done" event already arrived.
                try
                {
                    const doubtResult = await MetricBadgeManager.recordDoubtAsked(userId);
                    Logger.log(`[AskAi] doubt counted for ${userId} (doubtsAsked=${doubtResult.metrics.doubtsAsked})`, "DOCK");
                    if (!bResponseClosed)
                    {
                        response.write(JSON.stringify({ type: "metricsUpdate", metrics: doubtResult.metrics }) + "\n");
                    }
                }
                catch (doubtError)
                {
                    Logger.log(`[AskAi] doubt count failed for ${userId}: ${doubtError.message || doubtError}`, "DOCK");
                }
            }

            if (bResponseClosed) return;

            // The worker should always emit a {"type":"done"} sentinel before
            // exit. If it didn't (crash / OOM / signal), synthesise one plus
            // an error event so the client's stream reader doesn't hang.
            if (!bDoneEmitted)
            {
                Logger.warning(logCategory.AI_REQUEST, LogTitles.AI_ASK, `AskAI worker terminated unexpectedly (exit ${exitCode})`,
                {
                    accountId: userId,
                    additionalData: { taskType: taskType, referenceKey: chargeReferenceKey, outcome: "FAILED" }
                });
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
    /**
     * Drops any information source the caller does not actually own before the
     * payload is handed to the grounding worker.
     *
     * The grounding chunk store is content-addressed and shared between every
     * user who uploaded the same bytes, so a chunk carries no tenant of its own
     * — filtering the retrieval by hash alone means possession of a hash yields
     * the document text and the original uploader's filename. The hash is a
     * SHA-512 of the file, which is not a secret: anyone holding the same
     * widely-circulated PDF can compute it offline. So ownership is re-derived
     * here from the stored rows rather than trusted from the request.
     *
     * Validation only bounds the array's LENGTH; this is the authorisation step.
     * The Agent repeats the check independently (EmbeddingsQueryEngine takes an
     * owner user id and re-intersects), so neither layer depends on the other.
     *
     * @param {string} userId - The authenticated user.
     * @param {Array|undefined} requestedInformationSources - Client-supplied entries.
     * @param {string} askAiRequestTag - Correlation tag for the timing log.
     * @return {Promise<Array>} Only the entries whose hash the user owns.
     */
    static async #filterInformationSourcesToOwned(userId, requestedInformationSources, askAiRequestTag)
    {
        const informationSources = Array.isArray(requestedInformationSources) ? requestedInformationSources : [];
        if (informationSources.length === 0)
        {
            return [];
        }

        const requestedHashes = informationSources.map(entry =>
        {
            const nestedInformationSource = (entry && entry.informationSource) || {};
            return nestedInformationSource.hash;
        });

        const ownedHashes = new Set(await InformationSourceQueryEngine.filterHashesOwnedByUser(userId, requestedHashes));

        const ownedInformationSources = informationSources.filter(entry =>
        {
            const nestedInformationSource = (entry && entry.informationSource) || {};
            return ownedHashes.has(nestedInformationSource.hash);
        });

        const droppedCount = informationSources.length - ownedInformationSources.length;
        if (droppedCount > 0)
        {
            Logger.log(
                `[ASKAI_TIMING tag=${askAiRequestTag}] dropped ${droppedCount} information source(s) not owned by user ${userId}`,
                "DOCK",
            );
        }

        return ownedInformationSources;
    }

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
        if (contextKind !== "CARD" && contextKind !== "STUDY_MATERIAL" && contextKind !== "DECK")
        {
            return "contextKind must be 'CARD', 'STUDY_MATERIAL', or 'DECK'.";
        }

        // DECK = the deck-level Chat mode. The client does its own (client-side)
        // retrieval and passes the snippets + conversation history + deck-image
        // ids inside contextPayload; the worker grounds on them. Only bound the
        // total size here — the worker shapes the prompt.
        if (contextKind === "DECK")
        {
            const contextPayload = requestBody.contextPayload;
            if (typeof contextPayload !== "object" || contextPayload === null)
            {
                return "contextPayload is required for a DECK chat.";
            }
            let serializedSize = 0;
            try
            {
                serializedSize = JSON.stringify(contextPayload).length;
            }
            catch (serializeError)
            {
                return "contextPayload must be JSON-serializable.";
            }
            if (serializedSize > AskAiStreamRunner.#DECK_CONTEXT_MAX_CHARS)
            {
                return `DECK contextPayload exceeds ${AskAiStreamRunner.#DECK_CONTEXT_MAX_CHARS} chars.`;
            }
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

        // Output language is optional — absent means English (the no-op
        // default). When present it must be a known enum key so an
        // arbitrary string can't be threaded into the worker's prompt.
        if (requestBody.selectedLanguage !== undefined && requestBody.selectedLanguage !== null)
        {
            if (typeof requestBody.selectedLanguage !== "string"
                || !Object.prototype.hasOwnProperty.call(askAiLanguages, requestBody.selectedLanguage))
            {
                return "selectedLanguage must be one of the supported language keys.";
            }
        }

        // combineWithEnglish is optional and only meaningful for a
        // non-English language; when present it must be a boolean.
        if (requestBody.combineWithEnglish !== undefined && typeof requestBody.combineWithEnglish !== "boolean")
        {
            return "combineWithEnglish must be a boolean.";
        }

        return null;
    }

    /**
     * Deducts the tier's configured flat cost after a successful stream.
     * AskAi bypasses the task queue, so this is the authoritative charge —
     * there is no Agent-side hook that would otherwise meter it. A rule
     * that has gone missing or been disabled since the preflight simply
     * results in no charge (never a retroactive denial of a reply the
     * user has already received).
     * @param {string} userId
     * @param {number} taskType — TaskTypes value of the tier
     * @param {string} referenceKey — per-request idempotency key
     */
    static async #chargeForCompletedStream(userId, taskType, referenceKey)
    {
        const configuration = await CreditConfigurationStore.load();
        const rule = configuration.getRuleForTask(taskType);
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
            { taskType: taskType, source: "AskAi" },
            rule.getMinimumBalanceFloor()
        );

        if (chargeResult.rejected)
        {
            // The stream already completed, so the reply cannot be revoked —
            // log the floor breach for the admin instead of failing silently.
            Logger.log(`[AskAi] charge of ${chargeAmount} rejected by balance floor for user ${userId} (${referenceKey}).`, "DOCK");
        }

        Logger.info(logCategory.AI_REQUEST, LogTitles.AI_ASK, "AskAI request completed",
        {
            accountId: userId,
            additionalData: { taskType: taskType, credits: chargeAmount, referenceKey: referenceKey, rejected: !!chargeResult.rejected }
        });
    }
}

module.exports = AskAiStreamRunner;
