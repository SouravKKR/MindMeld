const TaskManager = require("../../Globals/Classes/Task/TaskManager");
const Persistence = require("../../Globals/Classes/Persistence");
const PersistenceConstants = require("../../Globals/Constants/PersistenceConstants");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");

const BEAUTIFIED_OUTPUT_FILE_NAME = "BeautifiedShortNames.json";


/**
 * Result-fetch companion to the now-async BeautifyDeckShortNames endpoint.
 *
 * Flow: POST /Admin/Decks/BeautifyShortNames returns a taskId and runs the
 * workflow in the background (so the request never blocks past Cloudflare's
 * ~100s edge timeout). The client polls /Generate/Progress?taskid=... and, once
 * the task is COMPLETED, GETs this endpoint to read back the deck-key →
 * short-name map the worker wrote under Tasks/<taskId>/.
 *
 * The map file is deleted after the read (one-shot). A missing/empty map yields
 * the same 503 the old synchronous endpoint returned, so the admin UI keeps its
 * "model overloaded — retry" behaviour.
 *
 * Admin-gated by ensureAdmin on the route. The task id is an unguessable UUID;
 * we additionally refuse to serve a task the requester doesn't own while it is
 * still in Redis.
 */
async function getBeautifiedShortNames(request, response)
{
    const params = await request.getQueryParams();
    const taskId = params["taskid"];

    if (!taskId)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: "MISSING_TASK_ID" });
        return;
    }

    // Best-effort ownership check. Once the task blob rolls off Redis (5h TTL)
    // getTask returns null and we fall back to the unguessable-id + admin gate.
    const task = await TaskManager.getTask(taskId);
    if (task !== null && task.getUserId() !== request.user.getId())
    {
        response.statusCode = httpStatus.FORBIDDEN;
        response.sendJson({ error: "TASK_NOT_OWNED" });
        return;
    }

    const outputPath = `${PersistenceConstants.TASKS_DIRECTORY}/${taskId}/${BEAUTIFIED_OUTPUT_FILE_NAME}`;

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
        console.warn(`[GetBeautifiedShortNames] Output file missing or unreadable for task ${taskId}: ${readError.message}`);
    }
    finally
    {
        // One-shot: drop the map file once read (best-effort; the GCS bucket has
        // lifecycle rules to garbage-collect any orphan the client never fetched).
        try { await Persistence.delete(outputPath); } catch (_) {}
    }

    // The workflow tolerates LLM failures so the post-generation path can still
    // publish deterministic names; the admin path instead surfaces the failure.
    // An empty/missing map almost always means a transient model 503 / quota.
    if (bFileMissing || Object.keys(beautifiedMap).length === 0)
    {
        response.statusCode = httpStatus.SERVICE_UNAVAILABLE;
        response.sendJson({
            error: ErrorCodes.BEAUTIFY_LLM_UNAVAILABLE,
            message: "The AI service did not return any short names. The model may be temporarily overloaded — please try again in a minute."
        });
        return;
    }

    response.statusCode = httpStatus.OK;
    response.sendJson({ shortNamesByKey: beautifiedMap });
}

module.exports = { getBeautifiedShortNames };
