const TaskDescriptor = require("../../Globals/Classes/Task/TaskDescriptor");
const TaskManager = require("../../Globals/Classes/Task/TaskManager");
const Persistence = require("../../Globals/Classes/Persistence");
const PersistenceConstants = require("../../Globals/Constants/PersistenceConstants");
const { taskTypes } = require("../../Globals/Enumerations/TaskTypes");
const { taskExecutionTargets } = require("../../Globals/Enumerations/TaskExecutionTargets");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");

const BEAUTIFIED_OUTPUT_FILE_NAME = "BeautifiedShortNames.json";
const MAX_DECK_CHAINS_PER_REQUEST = 500;


function sanitizeChain(rawChain)
{
    if (!Array.isArray(rawChain))
    {
        return null;
    }

    const cleaned = [];
    for (const part of rawChain)
    {
        if (typeof part !== "string")
        {
            continue;
        }
        const trimmed = part.trim();
        if (trimmed.length === 0)
        {
            continue;
        }
        cleaned.push(trimmed);
    }

    return cleaned.length > 0 ? cleaned : null;
}


/**
 * Admin-only short-name beautifier for an existing deck subtree.
 *
 * The client walks the deck hierarchy (in-memory Deck tree), builds a
 * list of full-name chains from the root of the subtree to each deck,
 * and posts them here. We hand them off to the python
 * BEAUTIFY_DECK_SHORT_NAMES workflow (same one Generate.js uses), then
 * read back the deck-key → beautified-name map and return it. The
 * client is responsible for applying the names to its own Deck
 * instances and triggering the usual save/sync path — that keeps the
 * sync system as the single source of truth for deck mutations and
 * avoids racing against the user's open editor.
 */
async function beautifyDeckShortNames(request, response)
{
    const body = await request.getBody();

    const requestedChains = Array.isArray(body?.deckChains) ? body.deckChains : null;

    if (!requestedChains || requestedChains.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: "MISSING_DECK_CHAINS" });
        return;
    }

    const sanitizedChains = [];
    for (const rawChain of requestedChains)
    {
        const cleaned = sanitizeChain(rawChain);
        if (cleaned !== null)
        {
            sanitizedChains.push(cleaned);
        }
    }

    if (sanitizedChains.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: "NO_VALID_DECK_CHAINS" });
        return;
    }

    if (sanitizedChains.length > MAX_DECK_CHAINS_PER_REQUEST)
    {
        response.statusCode = httpStatus.PAYLOAD_TOO_LARGE;
        response.sendJson({ error: "TOO_MANY_DECK_CHAINS", limit: MAX_DECK_CHAINS_PER_REQUEST });
        return;
    }

    const beautifyTask = new TaskDescriptor(
    {
        type: taskTypes.BEAUTIFY_DECK_SHORT_NAMES,
        executionTarget: taskExecutionTargets.LOCAL,
        userId: request.user.getId(),
        payload: { deckChains: sanitizedChains },
        nextTaskIds: [],
    });

    await TaskManager.setTask(beautifyTask);

    const mainTaskId = beautifyTask.getId();
    const outputPath = `${PersistenceConstants.TASKS_DIRECTORY}/${mainTaskId}/${BEAUTIFIED_OUTPUT_FILE_NAME}`;

    try
    {
        // execute(taskDescriptor, retries, mainTask, parentTaskId) — pass
        // the beautify task as its own mainTask so MAIN_TASK_ID resolves
        // to this task id. The workflow writes its output under
        // Tasks/<mainTaskId>/, which we read back below.
        const executed = await TaskManager.execute(beautifyTask, 0, beautifyTask, mainTaskId);

        if (executed === false)
        {
            response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
            response.sendJson({ error: "BEAUTIFY_TASK_FAILED" });
            return;
        }

        let beautifiedMap = {};
        let bFileMissing = false;
        try
        {
            const outputBuffer = await Persistence.read(outputPath);
            const parsedOutput = JSON.parse(outputBuffer.toString("utf-8"));
            if (parsedOutput && typeof parsedOutput === "object")
            {
                for (const [deckKey, candidateShortName] of Object.entries(parsedOutput))
                {
                    if (typeof candidateShortName === "string" && candidateShortName.length > 0)
                    {
                        beautifiedMap[deckKey] = candidateShortName;
                    }
                }
            }
        }
        catch (readError)
        {
            bFileMissing = true;
            console.warn(`[BeautifyDeckShortNames] Output file missing or unreadable for task ${mainTaskId}: ${readError.message}`);
        }

        // The workflow tolerates LLM failures so the post-generation
        // path can still publish a deck with deterministic short names.
        // For the admin-triggered path we want the opposite: surface
        // the failure so the user knows to retry. An empty file or 0
        // beautified entries almost always means the model returned
        // 503 / quota / blocked content — re-run usually works.
        if (bFileMissing || Object.keys(beautifiedMap).length === 0)
        {
            response.statusCode = httpStatus.SERVICE_UNAVAILABLE;
            response.sendJson({
                error: "BEAUTIFY_LLM_UNAVAILABLE",
                message: "The AI service did not return any short names. The model may be temporarily overloaded — please try again in a minute."
            });
            return;
        }

        response.statusCode = httpStatus.OK;
        response.sendJson({ shortNamesByKey: beautifiedMap });
    }
    finally
    {
        try
        {
            await Persistence.delete(outputPath);
        }
        catch (cleanupError)
        {
            // File may have never been written if the workflow failed
            // before reaching its write step — best-effort cleanup, the
            // GCS bucket has lifecycle rules to garbage-collect anyway.
        }
    }
}


module.exports = { beautifyDeckShortNames };
