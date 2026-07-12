const MockTestEvaluationConstants = require("../../Globals/Constants/MockTestEvaluationConstants");
const PersistenceConstants = require("../../Globals/Constants/PersistenceConstants");
const Persistence = require("../../Globals/Classes/Persistence");
const TaskManager = require("../../Globals/Classes/Task/TaskManager");
const { taskStatus } = require("../../Globals/Enumerations/TaskStatus");
const { getUser } = require("../Helpers/GetUser");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");


function joinPersistencePath(...segments)
{
    return segments
        .map((segment) => String(segment).replace(/^\/+|\/+$/g, ""))
        .filter((segment) => segment.length > 0)
        .join("/");
}


/**
 * Returns the TranscribedAnswers.json a TranscribeMockTestAttempt task produced,
 * so the client can populate its review-and-edit screen. The frontend polls the
 * task's progress separately (TaskProgressTracker) and calls this once the task
 * reports COMPLETED. Ownership is re-checked against the stored task descriptor —
 * a user can only read the transcription of a task they own.
 */
async function handleGetTranscriptionResult(request, response)
{
    const user = await getUser(request);
    if (!user)
    {
        response.statusCode = httpStatus.UNAUTHORIZED;
        response.end("Unauthorised.");
        return;
    }

    const body = await request.getBody();
    const transcriptionTaskId = body?.taskId;
    if (!transcriptionTaskId || typeof transcriptionTaskId !== "string")
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.end("taskId is required.");
        return;
    }

    const userId = user.getId();
    const task = await TaskManager.getTask(transcriptionTaskId);
    if (!task || task.getUserId() !== userId)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.end("Transcription task not found.");
        return;
    }

    const transcriptionPath = joinPersistencePath(
        PersistenceConstants.TASKS_DIRECTORY,
        transcriptionTaskId,
        PersistenceConstants.MOCK_TEST_TRANSCRIPTIONS_DIRECTORY,
        MockTestEvaluationConstants.TRANSCRIBED_ANSWERS_OUTPUT_FILENAME
    );

    let transcriptionDocument = null;
    try
    {
        const raw = await Persistence.read(transcriptionPath);
        transcriptionDocument = JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw));
    }
    catch (readError)
    {
        // No result object yet. If the task already failed, say so; otherwise
        // it is still running and the client should keep polling.
        const bFailed = task.getStatus() === taskStatus.FAILED;
        response.sendJson({ ready: false, failed: bFailed });
        return;
    }

    response.sendJson({ ready: true, transcription: transcriptionDocument });
}


module.exports = { handleGetTranscriptionResult };
