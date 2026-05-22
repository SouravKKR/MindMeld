const TaskDescriptor = require("../../Globals/Classes/Task/TaskDescriptor");
const TaskManager = require("../../Globals/Classes/Task/TaskManager");
const { taskTypes } = require("../../Globals/Enumerations/TaskTypes");
const { taskExecutionTargets } = require("../../Globals/Enumerations/TaskExecutionTargets");
const TaskHistoryQueryEngine = require("../../Globals/Classes/Database/TaskHistoryQueryEngine");
const { getUser } = require("../Helpers/GetUser");
const { userRoles } = require("../../Globals/Enumerations/UserRoles");


/**
 * POST /Analysis/QueueDeckAnalysis
 *
 * Lazy on-login trigger for the per-deck weekly analysis. The client
 * sends a deckId and an optional autoGenerateCuratedStudy flag. The
 * server queues an ANALYZE_DECK_PERFORMANCE task and returns the task
 * id immediately so the client never blocks on it.
 *
 * Eligibility checks (>=10 progress points, last-analysed > 7 days,
 * studied-since-last-analysis) are performed CLIENT-side inside
 * AutoAnalysisDispatcher before the request is sent. The server trusts
 * the client decision because it would have to re-walk the user's deck
 * tree to repeat the check, which is the exact work we want to avoid.
 */
async function handleQueueDeckAnalysis(request, response)
{
    const user = await getUser(request);

    if (!user)
    {
        response.statusCode = 401;
        response.end("Unauthorised.");
        return;
    }

    // AI features are admin-only during the closed-test phase. The frontend
    // already gates the dispatcher + checkbox toggles, but a stale client
    // (or a direct curl) can still reach here — enforce server-side so the
    // LLM call never fires for a non-admin.
    if (user.getRole() !== userRoles.ADMIN)
    {
        response.statusCode = 403;
        response.end("AI features are restricted to authorized roles.");
        return;
    }

    const body = await request.getBody();
    const deckId = body?.deckId;

    if (typeof deckId !== "string" || deckId.length === 0)
    {
        response.statusCode = 400;
        response.end("deckId is required.");
        return;
    }

    const autoGenerateCuratedStudy = body?.autoGenerateCuratedStudy === true;

    const analyzeDeckPerformanceTask = new TaskDescriptor({
        type: taskTypes.ANALYZE_DECK_PERFORMANCE,
        executionTarget: taskExecutionTargets.LOCAL,
        userId: user.getId(),
        payload:
        {
            deckId: deckId,
            autoGenerateCuratedStudy: autoGenerateCuratedStudy,
        },
        nextTaskIds: [],
    });

    await TaskManager.setTask(analyzeDeckPerformanceTask);
    await TaskManager.trackForUser(user.getId(), analyzeDeckPerformanceTask.getId());

    const taskId = analyzeDeckPerformanceTask.getId();

    response.statusCode = 202;
    response.sendJson({ taskId: taskId });

    TaskManager.execute(analyzeDeckPerformanceTask)
        .then(async () =>
        {
            try
            {
                const completedTask = await TaskManager.getTask(taskId);
                await TaskHistoryQueryEngine.recordCompletion(completedTask);
            }
            catch (recordError)
            {
                console.error(`[QueueDeckAnalysis] Failed to record taskHistory for ${taskId}: ${recordError.message}`);
            }
            await TaskManager.untrackForUser(user.getId(), taskId);
        })
        .catch(async (executionError) =>
        {
            console.error(`[QueueDeckAnalysis] Background execution failed for task ${taskId}:`, executionError);
            try
            {
                const failedTask = await TaskManager.getTask(taskId);
                await TaskHistoryQueryEngine.recordCompletion(failedTask);
            }
            catch (recordError)
            {
                console.error(`[QueueDeckAnalysis] Failed to record taskHistory for ${taskId} after failure: ${recordError.message}`);
            }
            await TaskManager.untrackForUser(user.getId(), taskId);
        });
}

module.exports = { handleQueueDeckAnalysis };
