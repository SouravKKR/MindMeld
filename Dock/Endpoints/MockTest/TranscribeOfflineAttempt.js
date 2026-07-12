const fs = require("fs/promises");

const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");
const MockTestEvaluationConstants = require("../../Globals/Constants/MockTestEvaluationConstants");
const PersistenceConstants = require("../../Globals/Constants/PersistenceConstants");
const Persistence = require("../../Globals/Classes/Persistence");
const TaskDescriptor = require("../../Globals/Classes/Task/TaskDescriptor");
const TaskManager = require("../../Globals/Classes/Task/TaskManager");
const TaskHistoryQueryEngine = require("../../Globals/Classes/Database/TaskHistoryQueryEngine");
const TranscriptionRequestBuilder = require("../../Globals/Classes/MockTestEvaluation/TranscriptionRequestBuilder");
const { taskTypes } = require("../../Globals/Enumerations/TaskTypes");
const { taskStatus } = require("../../Globals/Enumerations/TaskStatus");
const { taskExecutionTargets } = require("../../Globals/Enumerations/TaskExecutionTargets");
const KeyManagementService = require("../../Globals/Classes/Security/KeyManagementService");
const CreditPreflight = require("../../Globals/Classes/Credits/CreditPreflight");
const { getUser } = require("../Helpers/GetUser");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");
const MaintenanceGate = require("../../Globals/Classes/Maintenance/MaintenanceGate");


// Ceiling on how many scan pages one attempt may upload — kept in step with the
// Agent workflow's MAX_SCAN_PAGES so the server never stages more than the
// worker will send to the vision model.
const MAXIMUM_SCAN_FILE_COUNT = 24;

// Total upload budget across all scans for one attempt. A student's answer
// sheet is a handful of phone photos or one PDF; anything larger is almost
// certainly a mistake and must not be staged to GCS unbounded.
const MAXIMUM_TOTAL_UPLOAD_BYTES = 60 * 1024 * 1024;


function joinPersistencePath(...segments)
{
    return segments
        .map((segment) => String(segment).replace(/^\/+|\/+$/g, ""))
        .filter((segment) => segment.length > 0)
        .join("/");
}


/**
 * Reads a mock test's JSON from the normal MOCK_TESTS_COLLECTION. Identical to
 * the store EvaluateAttempt uses — in the unified model a paid deck's mock test
 * is a normal plaintext row here, tagged additionalData.paidDeckId.
 */
function createMockTestStore(database, userId)
{
    const mockTestsCollection = database.collection(DatabaseConstants.MOCK_TESTS_COLLECTION);
    return {
        async load(mockTestId)
        {
            const mongoDocument = await mockTestsCollection.findOne({ userId: userId, "data.id": mockTestId });
            return mongoDocument ? mongoDocument.data : null;
        }
    };
}


async function hasActivePaidDeckLicense(userId, deckId)
{
    const license = await KeyManagementService.getLicense(userId, deckId);
    return KeyManagementService.isLicenseActive(license);
}


/**
 * Derives a safe, lowercase file extension for a staged scan. Prefers the
 * original filename's extension, then the reported mime subtype, defaulting to
 * ".bin" (the Agent also sniffs PDF magic bytes, so a wrong extension is not
 * fatal — this is just for readable staging keys).
 */
function deriveScanExtension(scanFile)
{
    const fileName = typeof scanFile.filename === "string" ? scanFile.filename : "";
    const dotIndex = fileName.lastIndexOf(".");
    if (dotIndex >= 0)
    {
        const rawExtension = fileName.slice(dotIndex + 1).toLowerCase().replace(/[^a-z0-9]/g, "");
        if (rawExtension.length > 0 && rawExtension.length <= 5)
        {
            return rawExtension;
        }
    }

    const mimeType = typeof scanFile.mimeType === "string" ? scanFile.mimeType : "";
    if (mimeType === "application/pdf")
    {
        return "pdf";
    }
    const slashIndex = mimeType.indexOf("/");
    if (mimeType.startsWith("image/") && slashIndex >= 0)
    {
        const subtype = mimeType.slice(slashIndex + 1).toLowerCase().replace(/[^a-z0-9]/g, "");
        if (subtype.length > 0 && subtype.length <= 5)
        {
            return subtype === "jpeg" ? "jpg" : subtype;
        }
    }

    return "bin";
}


async function handleTranscribeOfflineAttempt(request, response)
{
    const user = await getUser(request);
    if (!user)
    {
        response.statusCode = httpStatus.UNAUTHORIZED;
        response.end("Unauthorised.");
        return;
    }

    const body = await request.getBody();
    const files = await request.getFiles();

    const mockTestId = body?.mockTestId;
    const attemptId = body?.attemptId;
    const paidDeckId = (typeof body?.paidDeckId === "string" && body.paidDeckId.length > 0) ? body.paidDeckId : null;

    if (!mockTestId || !attemptId)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.end("mockTestId and attemptId are required.");
        return;
    }

    const scanFiles = [].concat(files?.scan || []).filter((entry) => entry && typeof entry.path === "string");
    if (scanFiles.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.end("At least one scan file is required.");
        return;
    }
    if (scanFiles.length > MAXIMUM_SCAN_FILE_COUNT)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.end(`Too many scan files (max ${MAXIMUM_SCAN_FILE_COUNT}).`);
        return;
    }

    const totalUploadBytes = scanFiles.reduce((runningTotal, scanFile) => runningTotal + (Number.isFinite(scanFile.size) ? scanFile.size : 0), 0);
    if (totalUploadBytes > MAXIMUM_TOTAL_UPLOAD_BYTES)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.end("Uploaded scans exceed the size limit.");
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

    // Best-effort credit gate before staging anything or queuing the agent task.
    const creditPreflight = await CreditPreflight.check(userId, taskTypes.TRANSCRIBE_MOCK_TEST_ATTEMPT);
    if (!creditPreflight.allowed)
    {
        response.statusCode = httpStatus.PAYMENT_REQUIRED;
        response.sendJson({ error: creditPreflight.reason, balance: creditPreflight.balance, required: creditPreflight.required });
        return;
    }

    // Transcription launches an agent task, so respect the maintenance gate the
    // same way the LLM grading path does.
    const activeMaintenanceWindow = await MaintenanceGate.getActiveWindow();
    if (activeMaintenanceWindow !== null)
    {
        response.statusCode = httpStatus.SERVICE_UNAVAILABLE;
        response.sendJson(MaintenanceGate.buildMaintenanceResponsePayload(activeMaintenanceWindow));
        return;
    }

    const transcriptionTaskDescriptor = new TaskDescriptor({
        type: taskTypes.TRANSCRIBE_MOCK_TEST_ATTEMPT,
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

    const transcriptionTaskId = transcriptionTaskDescriptor.getId();
    const transcriptionsDirectory = joinPersistencePath(
        PersistenceConstants.TASKS_DIRECTORY,
        transcriptionTaskId,
        PersistenceConstants.MOCK_TEST_TRANSCRIPTIONS_DIRECTORY
    );

    // Stage every scan blob to GCS under the task directory, then drop a
    // TranscriptionRequest.json describing the questions the worker maps against.
    const scanFileNames = [];
    try
    {
        for (let scanIndex = 0; scanIndex < scanFiles.length; scanIndex += 1)
        {
            const scanFile = scanFiles[scanIndex];
            const scanBytes = await fs.readFile(scanFile.path);
            const scanFileName = `scan_${scanIndex}.${deriveScanExtension(scanFile)}`;
            await Persistence.write(joinPersistencePath(transcriptionsDirectory, scanFileName), scanBytes);
            scanFileNames.push(scanFileName);
        }

        const buildResult = TranscriptionRequestBuilder.build(mockTestJson, attemptId, scanFileNames);
        await Persistence.write(
            joinPersistencePath(transcriptionsDirectory, MockTestEvaluationConstants.TRANSCRIPTION_REQUEST_FILENAME),
            JSON.stringify(buildResult.payload)
        );
    }
    catch (stagingError)
    {
        console.error(`[TranscribeOfflineAttempt] Failed to stage transcription inputs for ${transcriptionTaskId}:`, stagingError);
        response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
        response.end(`Failed to stage scan uploads: ${stagingError?.message || stagingError}`);
        return;
    }
    finally
    {
        // The multipart temp files are ours to clean up regardless of outcome.
        for (const scanFile of scanFiles)
        {
            try { await fs.unlink(scanFile.path); } catch (unlinkError) { /* best effort */ }
        }
    }

    await TaskManager.setTask(transcriptionTaskDescriptor);
    await TaskManager.trackForUser(userId, transcriptionTaskId);

    response.sendJson({
        taskId: transcriptionTaskId,
        scanCount: scanFileNames.length
    });

    TaskManager.execute(transcriptionTaskDescriptor)
        .then(async () =>
        {
            try
            {
                const completedTask = await TaskManager.getTask(transcriptionTaskId);
                if (completedTask)
                {
                    await TaskHistoryQueryEngine.recordCompletion(completedTask);
                }
            }
            catch (postTaskError)
            {
                console.error(`[TranscribeOfflineAttempt] Post-task processing failed for ${transcriptionTaskId}:`, postTaskError);
            }
            finally
            {
                await TaskManager.untrackForUser(userId, transcriptionTaskId);
            }
        })
        .catch(async (taskError) =>
        {
            console.error(`[TranscribeOfflineAttempt] Transcription task ${transcriptionTaskId} threw:`, taskError);
            try
            {
                const failedTask = await TaskManager.getTask(transcriptionTaskId);
                if (failedTask)
                {
                    failedTask.setStatus(taskStatus.FAILED);
                    await TaskManager.updateTask(failedTask);
                    await TaskHistoryQueryEngine.recordCompletion(failedTask);
                }
            }
            catch (failureRecordingError)
            {
                console.error(`[TranscribeOfflineAttempt] Failed to record transcription failure for ${transcriptionTaskId}:`, failureRecordingError);
            }
            finally
            {
                await TaskManager.untrackForUser(userId, transcriptionTaskId);
            }
        });
}


module.exports = { handleTranscribeOfflineAttempt };
