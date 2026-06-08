const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");
const MockTestEvaluationConstants = require("../../Globals/Constants/MockTestEvaluationConstants");
const PersistenceConstants = require("../../Globals/Constants/PersistenceConstants");
const Persistence = require("../../Globals/Classes/Persistence");
const TaskDescriptor = require("../../Globals/Classes/Task/TaskDescriptor");
const TaskManager = require("../../Globals/Classes/Task/TaskManager");
const TaskHistoryQueryEngine = require("../../Globals/Classes/Database/TaskHistoryQueryEngine");
const EvaluationPayloadBuilder = require("../../Globals/Classes/MockTestEvaluation/EvaluationPayloadBuilder");
const OfflineAttemptGrader = require("../../Globals/Classes/MockTestEvaluation/OfflineAttemptGrader");
const GradedAttemptApplier = require("../../Globals/Classes/MockTestEvaluation/GradedAttemptApplier");
const { taskTypes } = require("../../Globals/Enumerations/TaskTypes");
const { taskStatus } = require("../../Globals/Enumerations/TaskStatus");
const { taskExecutionTargets } = require("../../Globals/Enumerations/TaskExecutionTargets");
const { mockTestEvaluationStatuses } = require("../../Globals/Enumerations/MockTestEvaluationStatuses");
const { getUser } = require("../Helpers/GetUser");


function joinPersistencePath(...segments)
{
    return segments
        .map((segment) => String(segment).replace(/^\/+|\/+$/g, ""))
        .filter((segment) => segment.length > 0)
        .join("/");
}


async function handleEvaluateAttempt(request, response)
{
    console.log("[EvaluateAttempt] >>> request received");

    const user = await getUser(request);
    if (!user)
    {
        console.warn("[EvaluateAttempt] rejected: no authenticated user");
        response.statusCode = 401;
        response.end("Unauthorised.");
        return;
    }

    const body = await request.getBody();
    const mockTestId = body?.mockTestId;
    const attemptId = body?.attemptId;
    const userEvaluationInstructions = typeof body?.evaluationInstructions === "string" ? body.evaluationInstructions : "";
    const enableLlmMcqFeedback = body?.enableLlmMcqFeedback === true;
    const attemptSnapshot = (body && typeof body.attemptSnapshot === "object" && body.attemptSnapshot !== null) ? body.attemptSnapshot : null;

    console.log(`[EvaluateAttempt] user=${user.getId()} mockTestId=${mockTestId} attemptId=${attemptId} enableLlmMcqFeedback=${enableLlmMcqFeedback} attemptSnapshotProvided=${attemptSnapshot !== null}`);

    if (!mockTestId || !attemptId)
    {
        console.warn("[EvaluateAttempt] rejected: missing mockTestId or attemptId");
        response.statusCode = 400;
        response.end("mockTestId and attemptId are required.");
        return;
    }

    const userId = user.getId();
    const database = await DatabaseConnector.getDatabase();
    const collection = database.collection(DatabaseConstants.MOCK_TESTS_COLLECTION);
    const mongoDocument = await collection.findOne({ userId: userId, "data.id": mockTestId });

    if (!mongoDocument)
    {
        console.warn(`[EvaluateAttempt] rejected: mock test ${mockTestId} not found in Mongo for user ${userId}`);
        response.statusCode = 404;
        response.end("Mock test not found.");
        return;
    }

    const mockTestJson = mongoDocument.data;
    let attemptJson = (mockTestJson.history || []).find((entry) => entry && entry.id === attemptId);

    if (!attemptJson)
    {
        // The Mongo copy of the mockTest doesn't contain this attempt
        // yet — most likely the sync push from the browser is still in
        // flight. Fall back to the browser-supplied snapshot (if any)
        // so we can proceed without waiting for the sync race to
        // settle. We also stitch the snapshot into mockTestJson.history
        // so any downstream consumer that walks the history sees it.
        if (attemptSnapshot && attemptSnapshot.id === attemptId)
        {
            console.log(`[EvaluateAttempt] attempt ${attemptId} not in Mongo yet — using attemptSnapshot from request body as fallback`);
            attemptJson = attemptSnapshot;
            if (!Array.isArray(mockTestJson.history))
            {
                mockTestJson.history = [];
            }
            mockTestJson.history.push(attemptJson);
        }
        else
        {
            console.warn(`[EvaluateAttempt] rejected: attempt ${attemptId} not found on mock test ${mockTestId} and no usable attemptSnapshot in body`);
            response.statusCode = 404;
            response.end(`Attempt ${attemptId} not found on mock test ${mockTestId}. Sync from the browser may not have completed yet — retry in a moment, or POST with an attemptSnapshot in the body.`);
            return;
        }
    }

    attemptJson.evaluationInstructions = userEvaluationInstructions;
    attemptJson.enableLlmMcqFeedback = enableLlmMcqFeedback;

    const buildResult = EvaluationPayloadBuilder.build(mockTestJson, attemptJson, userEvaluationInstructions, { enableLlmMcqFeedback });
    console.log(`[EvaluateAttempt] build complete: offlineGradableCount=${buildResult.offlineGradableCount} llmGradableCount=${buildResult.llmGradableCount} requiresAgentTask=${buildResult.requiresAgentTask}`);

    if (!buildResult.requiresAgentTask)
    {
        console.log("[EvaluateAttempt] taking offline-inline path (no Agent task spawn)");
        const gradedDocument = OfflineAttemptGrader.gradeAttempt(mockTestJson, attemptJson);
        GradedAttemptApplier.apply(mockTestJson, attemptId, gradedDocument);

        await collection.updateOne(
            { userId: userId, "data.id": mockTestId },
            { $set: { data: mockTestJson, serverUpdatedAt: new Date() } }
        );

        response.sendJson({
            taskId: null,
            mode: "offline",
            totalScore: gradedDocument.totalScore,
            maxScore: gradedDocument.maxScore
        });
        console.log(`[EvaluateAttempt] offline-inline complete: totalScore=${gradedDocument.totalScore} maxScore=${gradedDocument.maxScore}`);
        return;
    }

    console.log("[EvaluateAttempt] taking Agent-task path");
    attemptJson.evaluationStatus = mockTestEvaluationStatuses.GRADING;

    await collection.updateOne(
        { userId: userId, "data.id": mockTestId },
        { $set: { data: mockTestJson, serverUpdatedAt: new Date() } }
    );

    const evaluationTaskDescriptor = new TaskDescriptor({
        type: taskTypes.EVALUATE_MOCK_TEST_ATTEMPT,
        executionTarget: taskExecutionTargets.LOCAL,
        userId: userId,
        payload:
        {
            mockTestId: mockTestId,
            attemptId: attemptId
        },
        nextTaskIds: []
    });

    const evaluationTaskId = evaluationTaskDescriptor.getId();

    const attemptPersistencePath = joinPersistencePath(
        PersistenceConstants.TASKS_DIRECTORY,
        evaluationTaskId,
        PersistenceConstants.MOCK_TEST_EVALUATIONS_DIRECTORY,
        MockTestEvaluationConstants.ATTEMPT_INPUT_FILENAME
    );

    try
    {
        console.log(`[EvaluateAttempt] writing Attempt.json to '${attemptPersistencePath}'`);
        await Persistence.write(attemptPersistencePath, JSON.stringify(buildResult.payload));
        console.log(`[EvaluateAttempt] Attempt.json written OK`);
    }
    catch (writeError)
    {
        console.error(`[EvaluateAttempt] Failed to write attempt payload at '${attemptPersistencePath}':`, writeError);
        response.statusCode = 500;
        response.end(`Failed to stage evaluation payload: ${writeError?.message || writeError}`);
        return;
    }

    await TaskManager.setTask(evaluationTaskDescriptor);
    await TaskManager.trackForUser(userId, evaluationTaskId);
    console.log(`[EvaluateAttempt] TaskDescriptor ${evaluationTaskId} created + tracked for user ${userId}`);

    response.sendJson({
        taskId: evaluationTaskId,
        mode: "task",
        sentToLlmCount: buildResult.llmGradableCount,
        offlineGradableCount: buildResult.offlineGradableCount
    });
    console.log(`[EvaluateAttempt] response sent — Agent task ${evaluationTaskId} will now run in the background`);

    console.log(`[EvaluateAttempt] launching TaskManager.execute for ${evaluationTaskId}`);
    TaskManager.execute(evaluationTaskDescriptor)
        .then(async () =>
        {
            console.log(`[EvaluateAttempt] TaskManager.execute resolved successfully for ${evaluationTaskId}; running post-task hook`);
            try
            {
                await applyGradedAttemptFromTask(userId, mockTestId, attemptId, evaluationTaskId);
                const completedTask = await TaskManager.getTask(evaluationTaskId);
                if (completedTask)
                {
                    await TaskHistoryQueryEngine.recordCompletion(completedTask);
                }
                console.log(`[EvaluateAttempt] post-task hook complete for ${evaluationTaskId}`);
            }
            catch (postTaskError)
            {
                console.error(`[EvaluateAttempt] Post-task processing failed for ${evaluationTaskId}:`, postTaskError);
            }
            finally
            {
                await TaskManager.untrackForUser(userId, evaluationTaskId);
            }
        })
        .catch(async (taskError) =>
        {
            console.error(`[EvaluateAttempt] Evaluation task ${evaluationTaskId} threw:`, taskError);
            try
            {
                await markAttemptFailed(userId, mockTestId, attemptId);
                const failedTask = await TaskManager.getTask(evaluationTaskId);
                if (failedTask)
                {
                    failedTask.setStatus(taskStatus.FAILED);
                    await TaskManager.updateTask(failedTask);
                    await TaskHistoryQueryEngine.recordCompletion(failedTask);
                }
            }
            catch (failureRecordingError)
            {
                console.error(`[EvaluateAttempt] Failed to record evaluation failure for ${evaluationTaskId}:`, failureRecordingError);
            }
            finally
            {
                await TaskManager.untrackForUser(userId, evaluationTaskId);
            }
        });
}


async function applyGradedAttemptFromTask(userId, mockTestId, attemptId, evaluationTaskId)
{
    const gradedPath = joinPersistencePath(
        PersistenceConstants.TASKS_DIRECTORY,
        evaluationTaskId,
        PersistenceConstants.MOCK_TEST_EVALUATIONS_DIRECTORY,
        MockTestEvaluationConstants.GRADED_ATTEMPT_OUTPUT_FILENAME
    );

    let gradedDocument = null;
    try
    {
        const raw = await Persistence.read(gradedPath);
        gradedDocument = JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw));
    }
    catch (readError)
    {
        console.error(`[EvaluateAttempt] Could not read graded attempt at '${gradedPath}': ${readError.message}`);
        await markAttemptFailed(userId, mockTestId, attemptId);
        return;
    }

    const database = await DatabaseConnector.getDatabase();
    const collection = database.collection(DatabaseConstants.MOCK_TESTS_COLLECTION);
    const mongoDocument = await collection.findOne({ userId: userId, "data.id": mockTestId });

    if (!mongoDocument)
    {
        console.warn(`[EvaluateAttempt] Mock test ${mockTestId} disappeared before graded attempt could be applied.`);
        return;
    }

    const mockTestJson = mongoDocument.data;
    GradedAttemptApplier.apply(mockTestJson, attemptId, gradedDocument);

    await collection.updateOne(
        { userId: userId, "data.id": mockTestId },
        { $set: { data: mockTestJson, serverUpdatedAt: new Date() } }
    );
}


async function markAttemptFailed(userId, mockTestId, attemptId)
{
    const database = await DatabaseConnector.getDatabase();
    const collection = database.collection(DatabaseConstants.MOCK_TESTS_COLLECTION);
    const mongoDocument = await collection.findOne({ userId: userId, "data.id": mockTestId });
    if (!mongoDocument)
    {
        return;
    }
    const mockTestJson = mongoDocument.data;
    const attemptJson = (mockTestJson.history || []).find((entry) => entry && entry.id === attemptId);
    if (!attemptJson)
    {
        return;
    }
    attemptJson.evaluationStatus = mockTestEvaluationStatuses.FAILED;
    if (mockTestJson.lifecycle)
    {
        mockTestJson.lifecycle.lastModified = new Date().toISOString();
    }
    await collection.updateOne(
        { userId: userId, "data.id": mockTestId },
        { $set: { data: mockTestJson, serverUpdatedAt: new Date() } }
    );
}


module.exports = { handleEvaluateAttempt };
