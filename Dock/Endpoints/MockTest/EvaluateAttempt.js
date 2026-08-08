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
const KeyManagementService = require("../../Globals/Classes/Security/KeyManagementService");
const CreditPreflight = require("../../Globals/Classes/Credits/CreditPreflight");
const TaskStateManager = require("../../Globals/Classes/Task/TaskStateManager");
const EphemeralUploadRegistry = require("../../Globals/Classes/Content/EphemeralUploadRegistry");
const { ephemeralUploadKinds } = require("../../Globals/Enumerations/EphemeralUploadKinds");
const { getUser } = require("../Helpers/GetUser");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");
const MaintenanceGate = require("../../Globals/Classes/Maintenance/MaintenanceGate");
const PlanEntitlementGate = require("../../Globals/Classes/Plans/PlanEntitlementGate");
const { planFeatures } = require("../../Globals/Enumerations/PlanFeatures");


function joinPersistencePath(...segments)
{
    return segments
        .map((segment) => String(segment).replace(/^\/+|\/+$/g, ""))
        .filter((segment) => segment.length > 0)
        .join("/");
}


/**
 * Reads / writes a mock test's JSON in the normal MOCK_TESTS_COLLECTION.
 *
 * In the unified model a paid deck's mock test is a normal row in this
 * collection (plaintext server-side, tagged additionalData.paidDeckId), so paid
 * and non-paid grading share one store. The server grades against the plaintext
 * here; the /Sync pull encrypts the content fields on their way to the client.
 * (`paidDeckId` is retained on the signature only to gate access by an active
 * license in the handler; the store itself no longer branches on it.)
 */
function createMockTestStore(database, userId)
{
    const mockTestsCollection = database.collection(DatabaseConstants.MOCK_TESTS_COLLECTION);
    return {
        async load(mockTestId)
        {
            const mongoDocument = await mockTestsCollection.findOne({ userId: userId, "data.id": mockTestId });
            return mongoDocument ? mongoDocument.data : null;
        },
        async save(mockTestId, mockTestJson)
        {
            await mockTestsCollection.updateOne
            (
                { userId: userId, "data.id": mockTestId },
                { $set: { data: mockTestJson, serverUpdatedAt: new Date() } }
            );
        }
    };
}


/**
 * Ownership gate for paid-deck grading: the user must hold an ACTIVE,
 * unexpired license for the deck. Reuses KeyManagementService.isLicenseActive
 * so the expiry/sentinel logic stays identical to every other paid-deck gate
 * (epoch-zero / non-positive timestamp = lifetime sentinel).
 */
async function hasActivePaidDeckLicense(userId, deckId)
{
    const license = await KeyManagementService.getLicense(userId, deckId);
    return KeyManagementService.isLicenseActive(license);
}


async function handleEvaluateAttempt(request, response)
{
    const user = await getUser(request);
    if (!user)
    {
        response.statusCode = httpStatus.UNAUTHORIZED;
        response.end("Unauthorised.");
        return;
    }

    const body = await request.getBody();
    const mockTestId = body?.mockTestId;
    const attemptId = body?.attemptId;
    const userEvaluationInstructions = typeof body?.evaluationInstructions === "string" ? body.evaluationInstructions : "";
    const enableLlmMcqFeedback = body?.enableLlmMcqFeedback === true;
    const attemptSnapshot = (body && typeof body.attemptSnapshot === "object" && body.attemptSnapshot !== null) ? body.attemptSnapshot : null;
    // When set, the mock test belongs to a purchased paid deck and is sourced
    // from / written back to the buyer's encrypted per-user entity store.
    const paidDeckId = (typeof body?.paidDeckId === "string" && body.paidDeckId.length > 0) ? body.paidDeckId : null;

    if (!mockTestId || !attemptId)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.end("mockTestId and attemptId are required.");
        return;
    }

    const userId = user.getId();
    const database = await DatabaseConnector.getDatabase();

    if (paidDeckId && !(await hasActivePaidDeckLicense(userId, paidDeckId)))
    {
        response.statusCode = httpStatus.FORBIDDEN;
        response.end("No active license for this paid deck.");
        return;
    }

    const store = createMockTestStore(database, userId);
    const mockTestJson = await store.load(mockTestId);

    if (!mockTestJson)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.end("Mock test not found.");
        return;
    }

    let attemptJson = (mockTestJson.history || []).find((entry) => entry && entry.id === attemptId);

    if (!attemptJson)
    {
        // The stored copy doesn't have this attempt yet (the browser's
        // write may still be in flight). Fall back to the supplied snapshot.
        if (attemptSnapshot && attemptSnapshot.id === attemptId)
        {
            attemptJson = attemptSnapshot;
            if (!Array.isArray(mockTestJson.history))
            {
                mockTestJson.history = [];
            }
            mockTestJson.history.push(attemptJson);
        }
        else
        {
            response.statusCode = httpStatus.NOT_FOUND;
            response.end(`Attempt ${attemptId} not found on mock test ${mockTestId}. Retry in a moment, or POST with an attemptSnapshot in the body.`);
            return;
        }
    }

    attemptJson.evaluationInstructions = userEvaluationInstructions;
    attemptJson.enableLlmMcqFeedback = enableLlmMcqFeedback;

    const buildResult = EvaluationPayloadBuilder.build(mockTestJson, attemptJson, userEvaluationInstructions, { enableLlmMcqFeedback });

    if (!buildResult.requiresAgentTask)
    {
        const gradedDocument = OfflineAttemptGrader.gradeAttempt(mockTestJson, attemptJson);
        GradedAttemptApplier.apply(mockTestJson, attemptId, gradedDocument);

        await store.save(mockTestId, mockTestJson);

        response.sendJson({
            taskId: null,
            mode: "offline",
            totalScore: gradedDocument.totalScore,
            maxScore: gradedDocument.maxScore
        });
        return;
    }

    // Only the LLM grading path reaches here (offline grading already returned
    // above and is allowed during maintenance — it starts no agent task). The
    // scheduled-maintenance gate blocks STARTING this new agent task only.
    const activeMaintenanceWindow = await MaintenanceGate.getActiveWindow();
    if (activeMaintenanceWindow !== null)
    {
        response.statusCode = httpStatus.SERVICE_UNAVAILABLE;
        response.sendJson(MaintenanceGate.buildMaintenanceResponsePayload(activeMaintenanceWindow));
        return;
    }

    // Plan entitlement: LLM mock-test evaluation is a Basic-tier feature. The
    // offline-graded path already returned above (no AI, free on every tier);
    // only the LLM path reaches here. Refuse a lower tier before the credit
    // preflight so it sees an upgrade prompt, not an out-of-credits message.
    const evaluationEntitlement = await PlanEntitlementGate.requireFeatureForRequest(request, userId, planFeatures.MOCK_TEST_EVALUATION);
    if (!evaluationEntitlement.allowed)
    {
        response.statusCode = httpStatus.FORBIDDEN;
        response.sendJson({ error: evaluationEntitlement.reason, currentTier: evaluationEntitlement.currentTier, requiredTier: evaluationEntitlement.requiredTier });
        return;
    }

    // Best-effort credit gate before queuing the agent task.
    const creditPreflight = await CreditPreflight.check(userId, taskTypes.EVALUATE_MOCK_TEST_ATTEMPT);
    if (!creditPreflight.allowed)
    {
        const bIsResumable = creditPreflight.reason === ErrorCodes.INSUFFICIENT_CREDITS;
        if (bIsResumable)
        {
            try { await TaskStateManager.save({ userId: userId, taskType: taskTypes.EVALUATE_MOCK_TEST_ATTEMPT, route: "/MockTest/EvaluateAttempt", payload: body, pausedReason: creditPreflight.reason }); }
            catch (saveError) { console.warn(`[EvaluateAttempt] Failed to save resumable task state: ${saveError.message}`); }
        }
        response.statusCode = httpStatus.PAYMENT_REQUIRED;
        response.sendJson({ error: creditPreflight.reason, balance: creditPreflight.balance, required: creditPreflight.required, resumable: bIsResumable });
        return;
    }

    attemptJson.evaluationStatus = mockTestEvaluationStatuses.GRADING;
    await store.save(mockTestId, mockTestJson);

    const evaluationTaskDescriptor = new TaskDescriptor({
        type: taskTypes.EVALUATE_MOCK_TEST_ATTEMPT,
        executionTarget: taskExecutionTargets.LOCAL,
        userId: userId,
        payload:
        {
            mockTestId: mockTestId,
            attemptId: attemptId,
            paidDeckId: paidDeckId
        },
        nextTaskIds: []
    });

    const evaluationTaskId = evaluationTaskDescriptor.getId();

    const evaluationDirectory = joinPersistencePath(
        PersistenceConstants.TASKS_DIRECTORY,
        evaluationTaskId,
        PersistenceConstants.MOCK_TEST_EVALUATIONS_DIRECTORY
    );

    const attemptPersistencePath = joinPersistencePath(
        evaluationDirectory,
        MockTestEvaluationConstants.ATTEMPT_INPUT_FILENAME
    );

    // Registered BEFORE the write, for the same reason the transcription flow
    // beside it registers its prefix: the staged payload is the candidate's
    // answers together with the question text they answered, and nothing else
    // would ever remove it. The generation pipeline's task folder is cleaned by
    // moveToDatabase, which never runs for an evaluation task, so without this
    // an exam attempt stayed in the bucket permanently.
    //
    // The window is short because these files are a processing artefact, not a
    // record: the graded outcome is applied back to the mock test in Mongo and
    // that copy is what the learner and any dispute are answered from. The
    // success path below purges the prefix as soon as it has applied the
    // grades; this registration only has to cover the runs that fail.
    await EphemeralUploadRegistry.register
    ({
        storagePrefix: `${evaluationDirectory}/`,
        kind: ephemeralUploadKinds.MOCK_TEST_EVALUATION,
        userId: userId,
        retentionDays: DatabaseConstants.MOCK_TEST_EVALUATION_RETENTION_DAYS,
        metadata: { mockTestId: mockTestId, attemptId: attemptId, evaluationTaskId: evaluationTaskId },
    });

    try
    {
        await Persistence.write(attemptPersistencePath, JSON.stringify(buildResult.payload));
    }
    catch (writeError)
    {
        console.error(`[EvaluateAttempt] Failed to write attempt payload at '${attemptPersistencePath}':`, writeError);
        response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
        response.end(`Failed to stage evaluation payload: ${writeError?.message || writeError}`);
        return;
    }

    await TaskManager.setTask(evaluationTaskDescriptor);
    await TaskManager.trackForUser(userId, evaluationTaskId);

    response.sendJson({
        taskId: evaluationTaskId,
        mode: "task",
        sentToLlmCount: buildResult.llmGradableCount,
        offlineGradableCount: buildResult.offlineGradableCount
    });

    TaskManager.execute(evaluationTaskDescriptor)
        .then(async () =>
        {
            try
            {
                await applyGradedAttemptFromTask(database, userId, paidDeckId, mockTestId, attemptId, evaluationTaskId);
                const completedTask = await TaskManager.getTask(evaluationTaskId);
                if (completedTask)
                {
                    await TaskHistoryQueryEngine.recordCompletion(completedTask);
                }

                // The grades are in Mongo now, so the staged answers and the
                // graded output have no reader left. Purging here rather than
                // waiting out the retention window keeps the ordinary case
                // clean; the registration is what covers the runs that never
                // reach this line. purgePrefix drops the record too, so a
                // purged prefix is not re-listed on every reaper tick.
                await purgeEvaluationStaging(evaluationTaskId);
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
                await markAttemptFailed(database, userId, paidDeckId, mockTestId, attemptId);
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


/**
 * Removes an evaluation's staged input and graded output once they have been
 * applied.
 *
 * Never throws: the grades are already saved, so a storage failure here must
 * not turn a completed evaluation into a reported failure. The registry entry
 * survives a failed purge, which is exactly what makes the reaper retry it.
 *
 * @param {string} evaluationTaskId - The task whose staging folder to remove.
 * @returns {Promise<void>}
 */
async function purgeEvaluationStaging(evaluationTaskId)
{
    const evaluationDirectory = joinPersistencePath(
        PersistenceConstants.TASKS_DIRECTORY,
        evaluationTaskId,
        PersistenceConstants.MOCK_TEST_EVALUATIONS_DIRECTORY
    );

    try
    {
        await EphemeralUploadRegistry.purgePrefix(`${evaluationDirectory}/`);
    }
    catch (purgeError)
    {
        console.warn(`[EvaluateAttempt] Could not purge evaluation staging for ${evaluationTaskId}: ${purgeError?.message || purgeError}`);
    }
}


async function applyGradedAttemptFromTask(database, userId, paidDeckId, mockTestId, attemptId, evaluationTaskId)
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
        await markAttemptFailed(database, userId, paidDeckId, mockTestId, attemptId);
        return;
    }

    const store = createMockTestStore(database, userId);
    const mockTestJson = await store.load(mockTestId);

    if (!mockTestJson)
    {
        console.warn(`[EvaluateAttempt] Mock test ${mockTestId} disappeared before graded attempt could be applied.`);
        return;
    }

    GradedAttemptApplier.apply(mockTestJson, attemptId, gradedDocument);
    await store.save(mockTestId, mockTestJson);
}


async function markAttemptFailed(database, userId, paidDeckId, mockTestId, attemptId)
{
    const store = createMockTestStore(database, userId);
    const mockTestJson = await store.load(mockTestId);
    if (!mockTestJson)
    {
        return;
    }
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
    await store.save(mockTestId, mockTestJson);
}


module.exports = { handleEvaluateAttempt };
