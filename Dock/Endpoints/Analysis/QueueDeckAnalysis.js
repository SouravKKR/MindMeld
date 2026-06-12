const TaskDescriptor = require("../../Globals/Classes/Task/TaskDescriptor");
const TaskManager = require("../../Globals/Classes/Task/TaskManager");
const { taskTypes } = require("../../Globals/Enumerations/TaskTypes");
const { taskStatus } = require("../../Globals/Enumerations/TaskStatus");
const { taskExecutionTargets } = require("../../Globals/Enumerations/TaskExecutionTargets");
const TaskHistoryQueryEngine = require("../../Globals/Classes/Database/TaskHistoryQueryEngine");
const KeyManagementService = require("../../Globals/Classes/Security/KeyManagementService");
const CreditPreflight = require("../../Globals/Classes/Credits/CreditPreflight");
const TaskStateManager = require("../../Globals/Classes/Task/TaskStateManager");
const { getUser } = require("../Helpers/GetUser");
const { userRoles } = require("../../Globals/Enumerations/UserRoles");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");


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
        response.statusCode = httpStatus.UNAUTHORIZED;
        response.end("Unauthorised.");
        return;
    }

    const body = await request.getBody();
    const deckId = body?.deckId;

    if (typeof deckId !== "string" || deckId.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.end("deckId is required.");
        return;
    }

    // A paid request is identified by a non-empty paidDeckId in the body — the
    // agent uses it to read the buyer's cards from paidDeckUserContentEntities
    // and write results back into that same encrypted per-user store. Paid
    // analysis is gated by an ACTIVE license (ownership); regular own-deck
    // analysis stays admin-only during the closed-test phase. (A stale client
    // or a direct curl can still reach here, so both checks are server-side.)
    const paidDeckId = typeof body?.paidDeckId === "string" ? body.paidDeckId : "";
    const isPaidDeckAnalysis = paidDeckId.length > 0;

    if (isPaidDeckAnalysis)
    {
        const license = await KeyManagementService.getLicense(user.getId(), paidDeckId);
        if (!KeyManagementService.isLicenseActive(license))
        {
            response.statusCode = httpStatus.FORBIDDEN;
            response.sendJson({ error: "NO_ACTIVE_LICENSE" });
            return;
        }
    }
    else if (user.getRole() !== userRoles.ADMIN)
    {
        response.statusCode = httpStatus.FORBIDDEN;
        response.end("AI features are restricted to authorized roles.");
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

    // Best-effort credit gate. The Agent is the authoritative charger, but
    // rejecting an unaffordable run here gives immediate feedback instead of
    // launching a pipeline the Agent would refuse at its first task.
    const creditPreflight = await CreditPreflight.check(user.getId(), taskTypes.ANALYZE_DECK_PERFORMANCE);
    if (!creditPreflight.allowed)
    {
        const bIsResumable = creditPreflight.reason === "INSUFFICIENT_CREDITS";
        if (bIsResumable)
        {
            try { await TaskStateManager.save({ userId: user.getId(), taskType: taskTypes.ANALYZE_DECK_PERFORMANCE, route: "/Analysis/QueueDeckAnalysis", payload: body, pausedReason: creditPreflight.reason }); }
            catch (saveError) { console.warn(`[QueueDeckAnalysis] Failed to save resumable task state: ${saveError.message}`); }
        }
        response.statusCode = httpStatus.PAYMENT_REQUIRED;
        response.sendJson({ error: creditPreflight.reason, balance: creditPreflight.balance, required: creditPreflight.required, resumable: bIsResumable });
        return;
    }

    const taskPayload =
    {
        deckId: deckId,
        autoGenerateCuratedStudy: autoGenerateCuratedStudy,
        force: force,
        skipAnalysis: skipAnalysis,
        regenerateTopics: regenerateTopics,
    };

    if (isPaidDeckAnalysis)
    {
        // Paid-source mode: the agent reads/writes the buyer's per-user
        // plaintext store keyed by (userId, paidDeckId).
        taskPayload.paidDeckId = paidDeckId;
        taskPayload.userId = user.getId();
    }

    const analyzeDeckPerformanceTask = new TaskDescriptor({
        type: taskTypes.ANALYZE_DECK_PERFORMANCE,
        executionTarget: taskExecutionTargets.LOCAL,
        userId: user.getId(),
        payload: taskPayload,
        nextTaskIds: [],
    });

    await TaskManager.setTask(analyzeDeckPerformanceTask);
    await TaskManager.trackForUser(user.getId(), analyzeDeckPerformanceTask.getId());

    const taskId = analyzeDeckPerformanceTask.getId();

    response.statusCode = httpStatus.ACCEPTED;
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
