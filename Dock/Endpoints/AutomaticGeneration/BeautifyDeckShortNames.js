const TaskDescriptor = require("../../Globals/Classes/Task/TaskDescriptor");
const TaskManager = require("../../Globals/Classes/Task/TaskManager");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");
const { getUser } = require("../Helpers/GetUser");
const { taskTypes } = require("../../Globals/Enumerations/TaskTypes");
const { taskExecutionTargets } = require("../../Globals/Enumerations/TaskExecutionTargets");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");

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
 * Short-name beautifier for an existing deck subtree, available to any
 * signed-in user.
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
 *
 * Credits: the task carries the requesting user's id, so the Agent's
 * per-task credit charger bills the BEAUTIFY_DECK_SHORT_NAMES spend rule
 * (when one is configured) just like any other metered AI feature.
 */
async function beautifyDeckShortNames(request, response)
{
    const user = await getUser(request);

    if (!user)
    {
        response.statusCode = httpStatus.UNAUTHORIZED;
        response.end("Unauthorised.");
        return;
    }

    const body = await request.getBody();

    const requestedChains = Array.isArray(body?.deckChains) ? body.deckChains : null;

    if (!requestedChains || requestedChains.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.MISSING_DECK_CHAINS });
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
        response.sendJson({ error: ErrorCodes.NO_VALID_DECK_CHAINS });
        return;
    }

    if (sanitizedChains.length > MAX_DECK_CHAINS_PER_REQUEST)
    {
        response.statusCode = httpStatus.PAYLOAD_TOO_LARGE;
        response.sendJson({ error: ErrorCodes.TOO_MANY_DECK_CHAINS, limit: MAX_DECK_CHAINS_PER_REQUEST });
        return;
    }

    const requestingUserId = user.getId();

    const beautifyTask = new TaskDescriptor(
    {
        type: taskTypes.BEAUTIFY_DECK_SHORT_NAMES,
        executionTarget: taskExecutionTargets.LOCAL,
        userId: requestingUserId,
        payload: { deckChains: sanitizedChains },
        nextTaskIds: [],
    });

    await TaskManager.setTask(beautifyTask);

    const mainTaskId = beautifyTask.getId();

    // Beautifying a large subtree is an LLM round-trip that can exceed
    // Cloudflare's ~100s edge timeout (HTTP 524). So instead of blocking the
    // request on TaskManager.execute, return the task id immediately and run the
    // workflow in the background. The client polls /Generate/Progress?taskid=...
    // until COMPLETED, then GETs /Decks/BeautifyShortNames/Result to read
    // back the deck-key → short-name map the worker wrote under Tasks/<id>/.
    response.statusCode = httpStatus.OK;
    response.sendJson({ taskId: mainTaskId });

    // execute(taskDescriptor, retries, mainTask, parentTaskId) — pass the beautify
    // task as its own mainTask so MAIN_TASK_ID resolves to this task id and the
    // worker writes Tasks/<mainTaskId>/<BEAUTIFIED_OUTPUT_FILE_NAME>. The worker
    // also sets the task's terminal status in Redis, which the client's poll sees.
    TaskManager.execute(beautifyTask, 0, beautifyTask, mainTaskId)
        .catch((executionError) =>
        {
            console.error(`[BeautifyDeckShortNames] Background execution failed for task ${mainTaskId} (user ${requestingUserId}): ${executionError.message}`);
        });
}


module.exports = { beautifyDeckShortNames };
