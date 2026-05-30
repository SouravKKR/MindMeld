const TaskDescriptor = require("../../Globals/Classes/Task/TaskDescriptor");
const TaskManager = require("../../Globals/Classes/Task/TaskManager");
const { taskTypes } = require("../../Globals/Enumerations/TaskTypes");
const { taskStatus } = require("../../Globals/Enumerations/TaskStatus");
const { taskExecutionTargets } = require("../../Globals/Enumerations/TaskExecutionTargets");
const TaskHistoryQueryEngine = require("../../Globals/Classes/Database/TaskHistoryQueryEngine");
const { getUser } = require("../Helpers/GetUser");
const { userRoles } = require("../../Globals/Enumerations/UserRoles");


/**
 * POST /Analysis/QueueDeckAnalysis
 *
 * Trigger an ANALYZE_DECK_PERFORMANCE task for the given deck. Used by
 * both the lazy on-login dispatcher and the explicit "Run analysis
 * now" button on the Insights page. The response is always
 * `{ taskId, bAlreadyRunning }`: the client polls /Generate/Progress
 * the same way whether it joined an existing run or kicked a new one.
 *
 * Duplicate-detection: if the user already has a non-terminal
 * ANALYZE_DECK_PERFORMANCE task in their active-tasks set with the
 * same deckId, that task's id is returned instead of starting a new
 * one. Prevents racing LLM calls against the same deck (which would
 * also race writes to the same `lastAnalysisTopics` field on Mongo).
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

    // Curated-study control flags:
    //   `force` — bypasses the LIVE-batch engagement check on the
    //     agent side. Used by the entry-dialog Regenerate button and
    //     by mid-session feedback-driven regen so an active batch
    //     can be intentionally replaced.
    //   `skipAnalysis` — instructs the agent to skip Gemini's
    //     topic-detection pass and use `regenerateTopics` as the
    //     authoritative topic list instead. Used by the Continue
    //     branch (only-hard-topic regen) and the COMPLETED_ALL_EASY
    //     auto-queue (same-topics refresh).
    //   `regenerateTopics` — array of {name, strength, reason?,
    //     topicIndex?, hardCards?} consumed when `skipAnalysis` is
    //     true. `hardCards` carries question/answer pairs the
    //     student just got wrong so the LLM addresses the
    //     underlying confusion directly.
    const force = body?.force === true;
    const skipAnalysis = body?.skipAnalysis === true;
    const regenerateTopics = Array.isArray(body?.regenerateTopics) ? body.regenerateTopics : [];

    // Duplicate detection — find any non-terminal ANALYZE_DECK_PERFORMANCE
    // task this user already has running against this same deck. Two
    // concurrent runs would race the LLM call AND the final write to
    // `deck.additionalData.lastAnalysisTopics`, so we route the
    // caller onto the existing run instead.
    const existingActiveTask = await findExistingAnalysisTask(user.getId(), deckId);
    if (existingActiveTask !== null)
    {
        // 409 surfaces the conflict so the frontend can decide between
        // joining the running task or showing a "still running" prompt.
        // The taskId is still returned so AnalysisTaskRunner can poll
        // the existing run either way; `bAlreadyRunning` keeps the
        // legacy contract for the dispatcher's silent join path.
        const wasForcedAttempt = force;
        response.statusCode = wasForcedAttempt ? 409 : 200;
        response.sendJson({
            taskId: existingActiveTask.getId(),
            bAlreadyRunning: true,
            reason: wasForcedAttempt ? "force_blocked_by_active_task" : "joined_existing_task",
        });
        return;
    }

    const analyzeDeckPerformanceTask = new TaskDescriptor({
        type: taskTypes.ANALYZE_DECK_PERFORMANCE,
        executionTarget: taskExecutionTargets.LOCAL,
        userId: user.getId(),
        payload:
        {
            deckId: deckId,
            autoGenerateCuratedStudy: autoGenerateCuratedStudy,
            force: force,
            skipAnalysis: skipAnalysis,
            regenerateTopics: regenerateTopics,
        },
        nextTaskIds: [],
    });

    await TaskManager.setTask(analyzeDeckPerformanceTask);
    await TaskManager.trackForUser(user.getId(), analyzeDeckPerformanceTask.getId());

    const taskId = analyzeDeckPerformanceTask.getId();

    response.statusCode = 202;
    response.sendJson({ taskId: taskId, bAlreadyRunning: false });

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

/**
 * Returns the TaskDescriptor of the user's currently-running ANALYZE_DECK_PERFORMANCE
 * task for the given deckId, or null if none is running. Reuses
 * TaskManager.listActiveForUser (which auto-heals stale ids).
 */
async function findExistingAnalysisTask(userId, deckId)
{
    const activeTasks = await TaskManager.listActiveForUser(userId);
    for (const activeTask of activeTasks)
    {
        if (activeTask.getType() !== taskTypes.ANALYZE_DECK_PERFORMANCE)
        {
            continue;
        }

        const taskPayload = activeTask.getPayload() || {};
        if (taskPayload.deckId !== deckId)
        {
            continue;
        }

        const currentStatus = activeTask.getStatus();
        if (currentStatus === taskStatus.COMPLETED || currentStatus === taskStatus.FAILED)
        {
            continue;
        }

        return activeTask;
    }
    return null;
}

module.exports = { handleQueueDeckAnalysis };
