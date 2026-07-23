const { PacketronRequest, PacketronResponse } = require("@gamiumgamers/packetron");
const InformationSource = require("../../Globals/Model/InformationSource");
const { getUser } = require("../Helpers/GetUser");
const { computeFileSha512Hash } = require("../../Globals/UtilityFunctions.js/ComputeFileSha512Hash");
const Persistence = require("../../Globals/Classes/Persistence");
const { storageTargets } = require("../../Globals/Enumerations/StorageTargets");
const { contentRetentionModes } = require("../../Globals/Enumerations/ContentRetentionModes");
const { ocrModes } = require("../../Globals/Enumerations/OcrModes");
const InformationSourceQueryEngine = require("../../Globals/Classes/Database/InformationSourceQueryEngine");
const PersistenceConstants = require("../../Globals/Constants/PersistenceConstants");
const { joinPath } = require("../../Globals/UtilityFunctions.js/JoinPath");
const UploadQuotaManager = require("../../Globals/Classes/Quotas/UploadQuotaManager");
const StorageQuotaEnforcer = require("../../Globals/Classes/Storage/StorageQuotaEnforcer");
const TaskManager = require("../../Globals/Classes/Task/TaskManager");
const TaskDescriptor = require("../../Globals/Classes/Task/TaskDescriptor");
const { taskTypes } = require("../../Globals/Enumerations/TaskTypes");
const { taskStatus } = require("../../Globals/Enumerations/TaskStatus");
const { taskExecutionTargets } = require("../../Globals/Enumerations/TaskExecutionTargets");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");

const uploadQuotaManager = new UploadQuotaManager();


/**
 * Marks a tracking task terminal (COMPLETED/FAILED) and persists it so the
 * client's /Generate/Progress poll resolves. On failure the reason is stamped
 * onto payload.error, which GetProgress surfaces to the client.
 *
 * @param {TaskDescriptor} task
 * @param {number} status - taskStatus.COMPLETED or taskStatus.FAILED
 * @param {string|null} errorMessage
 */
async function markTrackingTaskTerminal(task, status, errorMessage)
{
    task.setStatus(status);
    task.setCompletion(status === taskStatus.COMPLETED ? 1 : task.getCompletion());

    if (errorMessage)
    {
        task.setPayload({ ...(task.getPayload() || {}), error: errorMessage });
    }

    try
    {
        await TaskManager.updateTask(task);
    }
    catch (updateError)
    {
        console.error(`[InformationSourceUpload] Failed to mark tracking task ${task.getId()} terminal: ${updateError.message}`);
    }
}

/**
 * Background finalizer for a first-time upload. It runs entirely AFTER the HTTP
 * response has returned (so the request never blocks past Cloudflare's ~100s
 * edge timeout) and OFF the Dock process — the actual OCR is handed to the
 * worker pool (a local worker, or a burst VM under load) so concurrent uploads
 * don't peg the base node:
 *
 *   1. Upload the original to a per-task STAGING key in GCS (NOT the content
 *      path). Keeping it off the content-addressed key is what preserves the CAS
 *      invariant — the content path only ever holds the OCRed PDF, so a
 *      concurrent reuse can never grab a not-yet-OCRed object.
 *   2. Enqueue an OcrPdf task ({ ...source, ocrInputPath: <staging> }). The worker
 *      reads the staging key, OCRs, and writes the OCRed PDF to the content path.
 *   3. On success, save the InformationSource + record quota, THEN mark the
 *      tracking task COMPLETED — so the client (which polls the TRACKING task,
 *      not the OcrPdf task) only sees success once the source is fully usable.
 *
 * Rollback discipline:
 *   - OCR failure: OcrPdf writes the content path only on success, so a failure
 *     leaves nothing there — nothing to undo.
 *   - DB save failure (non-duplicate): the content object is content-addressed
 *     and may be shared with another user's row — it is NOT deleted.
 *   - DB save duplicate-key (E11000): a concurrent same-user request already
 *     inserted the canonical row; the content is valid, so the task is COMPLETED.
 *   - The staging object + local copy are always cleaned up.
 */
async function finalizeOcrUploadInBackground({ trackingTask, localStagingFilePath, gcsStagingPath, informationSourcePath, informationSource, userId, fileSizeBytes })
{
    let bStagedToGcs = false;

    try
    {
        // Move the original up to the per-task staging key (removes the local copy).
        await Persistence.move(
            localStagingFilePath,
            storageTargets.LOCAL_FILE_SYSTEM,
            gcsStagingPath,
            storageTargets.LINODE_OBJECT_STORAGE,
        );
        bStagedToGcs = true;

        // Hand OCR to the worker pool. OcrPdf reads ocrInputPath (staging) and
        // writes the OCRed PDF to the content-addressed path it derives from the
        // source's hash + directory. With the queue enabled this runs on a local
        // or burst worker; in --debug it runs as a local Python subprocess.
        const ocrTask = new TaskDescriptor({
            userId: userId,
            type: taskTypes.OCR_PDF,
            executionTarget: taskExecutionTargets.LOCAL,
            payload: {
                ...informationSource.toJson(),
                ocrMode: ocrModes.ENABLED,
                ocrInputPath: gcsStagingPath
            },
            nextTaskIds: []
        });
        await TaskManager.setTask(ocrTask);

        const bOcrSucceeded = await TaskManager.execute(ocrTask, 0, ocrTask, ocrTask.getId());
        if (bOcrSucceeded === false)
        {
            const ocrTaskAfterRun = await TaskManager.getTask(ocrTask.getId());
            const reason = ocrTaskAfterRun?.getPayload()?.error || "OCR task did not complete.";
            throw new Error(reason);
        }

        // Defensive: OcrPdf writes the content object only when it actually OCRs
        // (ENABLED + an OCRable source type). Don't trust execute()===true alone as
        // proof — verify the OCRed object exists before persisting the row, so a
        // future caller change (e.g. a DISABLED upload) can't strand a "saved"
        // source pointing at a missing GCS object.
        const bContentObjectWritten = await Persistence.exists(informationSourcePath, storageTargets.LINODE_OBJECT_STORAGE);
        if (!bContentObjectWritten)
        {
            throw new Error("OCR task completed but produced no output object.");
        }

        // OCR done — the OCRed PDF now lives at the content path. Persist the row.
        await InformationSourceQueryEngine.saveInformationSource(informationSource);
        await uploadQuotaManager.record(userId, fileSizeBytes);
        // The upload grew the user's footprint — drop the cached measurement so
        // the next storage-meter read (and the next quota check) re-measures.
        StorageQuotaEnforcer.invalidate(userId);

        await markTrackingTaskTerminal(trackingTask, taskStatus.COMPLETED, null);
    }
    catch (error)
    {
        const bIsDuplicateKeyError = error?.code === 11000 || /E11000/.test(error?.message ?? "");

        if (bIsDuplicateKeyError)
        {
            console.warn(`[InformationSourceUpload] Concurrent upload race resolved by unique index for ${userId} (task ${trackingTask.getId()}).`);
            await markTrackingTaskTerminal(trackingTask, taskStatus.COMPLETED, null);
        }
        else
        {
            console.error(`[InformationSourceUpload] Async OCR finalize failed (task ${trackingTask.getId()}): ${error.message}`);
            await markTrackingTaskTerminal(trackingTask, taskStatus.FAILED, error.message);
        }
    }
    finally
    {
        if (bStagedToGcs)
        {
            try { await Persistence.delete(gcsStagingPath, storageTargets.LINODE_OBJECT_STORAGE); } catch (_) {}
        }
        try { fs.unlinkSync(localStagingFilePath); } catch (_) {}
    }
}


/**
 * Handles the upload of an information source. Expects the InformationSource
 * JSON as a "metadata" query parameter and the file under multipart field
 * "file".
 *
 * Response contract:
 *   - Fast path (the OCRed PDF already exists in GCS, or a per-user duplicate):
 *     returns the bare InformationSource JSON (or 409) exactly as before — the
 *     source is immediately usable.
 *   - First-time upload: returns `{ taskId, informationSource }` IMMEDIATELY and
 *     finalizes asynchronously (see finalizeOcrUploadInBackground). The client
 *     polls /Generate/Progress?taskid=... until the tracking task is COMPLETED,
 *     then uses `informationSource`.
 *
 * Storage contract (content-addressed):
 *   - The CAS key is sha512(originalFileBytes).
 *   - The GCS object at that key is ALWAYS the OCRed PDF — the original is staged
 *     under a separate per-task key and removed after OCR, so the invariant "if
 *     it exists in GCS, it is OCRed" holds by construction and a concurrent reuse
 *     never sees a half-processed object.
 *   - If any user has already uploaded the same content the existing GCS object
 *     is reused — neither OCR nor upload repeats.
 *
 * @param {PacketronRequest} request
 * @param {PacketronResponse} response
 * @returns {Promise<void>}
 */
async function handleInformationSourceUpload(request, response)
{
    const user = await getUser(request);

    if (!user)
    {
        response.statusCode = httpStatus.UNAUTHORIZED;
        response.end("Unauthorized.");
        return;
    }

    const queryParams = await request.getQueryParams();
    const files = await request.getFiles();
    const uploadedFilePath = files.file;

    let fileSizeBytes = 0;
    try
    {
        fileSizeBytes = fs.statSync(uploadedFilePath).size;
    }
    catch (statError)
    {
        fileSizeBytes = 0;
    }

    const quotaCheck = await uploadQuotaManager.check(user.getId(), fileSizeBytes);
    if (!quotaCheck.allowed)
    {
        response.statusCode = httpStatus.TOO_MANY_REQUESTS;
        response.sendJson({
            error: ErrorCodes.UPLOAD_QUOTA_EXCEEDED,
            reason: quotaCheck.reason,
            remainingFiles: quotaCheck.remainingFiles,
            remainingBytes: quotaCheck.remainingBytes,
            resetAt: quotaCheck.resetAt
        });
        return;
    }

    // Persistent plan storage cap. Uploads share the single storage budget with
    // synced deck content (StorageQuotaEnforcer counts both), so a file that
    // would push the combined footprint over the plan cap is refused here BEFORE
    // the blob is stored — the daily throttle above is a separate anti-abuse
    // limit, not the cumulative cap the Settings storage meter shows.
    if (!(await StorageQuotaEnforcer.wouldFitWithinQuota(user.getId(), fileSizeBytes)))
    {
        response.statusCode = httpStatus.PAYLOAD_TOO_LARGE;
        response.sendJson({
            error: ErrorCodes.STORAGE_QUOTA_EXCEEDED,
            limitBytes: await StorageQuotaEnforcer.getLimitBytes(user.getId())
        });
        return;
    }

    const metadataJson = JSON.parse(queryParams.metadata);
    const informationSource = InformationSource.fromJson(metadataJson);

    // retentionMode drives storage billing (TEMPORARY sources are exempt). The
    // generated fromJson leaves it null when the client omits it, but the
    // StorageCreditAssessor only counts PERMANENT (or legacy $exists:false)
    // documents — a persisted null would silently escape billing. Default an
    // omitted mode to PERMANENT so the contract documented below holds.
    if (informationSource.getRetentionMode() === null)
    {
        informationSource.setRetentionMode(contentRetentionModes.PERMANENT);
    }

    const contentAddressedKey = await computeFileSha512Hash(uploadedFilePath);

    informationSource.setUserId(user.getId());
    informationSource.setHash(contentAddressedKey);

    // Persist the measured upload size so the storage-credit assessor can
    // bill the GCS-bucket footprint without re-reading the blob.
    informationSource.setFileSizeBytes(fileSizeBytes);

    const bIsDuplicate = await InformationSourceQueryEngine.doesUserAlreadyHaveInformationSourceWithSameContent(
        user.getId(),
        contentAddressedKey,
    );

    if (bIsDuplicate)
    {
        response.statusCode = httpStatus.CONFLICT;
        response.end("You have already uploaded a source with the same content.");
        return;
    }

    const informationSourceDirectory = joinPath("/", PersistenceConstants.INFORMATION_SOURCE_DIRECTORY);
    const informationSourcePath = joinPath("/", informationSourceDirectory, contentAddressedKey);

    informationSource.setDirectoryPath(informationSourceDirectory);

    // ── Global CAS check ──
    // If the OCRed PDF for this content already exists in GCS (uploaded by any
    // user), reuse it — skip OCR entirely and return the ready source directly.
    const bAlreadyInContentStore = await Persistence.exists(informationSourcePath, storageTargets.LINODE_OBJECT_STORAGE);

    if (bAlreadyInContentStore)
    {
        await InformationSourceQueryEngine.saveInformationSource(informationSource);
        await uploadQuotaManager.record(user.getId(), fileSizeBytes);
        // The upload grew the user's footprint — drop the cached measurement so
        // the next storage-meter read (and the next quota check) re-measures.
        StorageQuotaEnforcer.invalidate(user.getId());
        response.sendJson(informationSource.toJson());
        return;
    }

    // ── First-time upload: register a tracking task and finalize asynchronously ──
    // The multipart temp file may be reaped once this handler returns, so copy it
    // to a stable local path the background finalize can still read/upload.
    const localStagingFilePath = path.join(os.tmpdir(), `cogniumlearn-upload-${Date.now()}-${crypto.randomBytes(8).toString("hex")}.bin`);

    try
    {
        await fs.promises.copyFile(uploadedFilePath, localStagingFilePath);
    }
    catch (stagingError)
    {
        console.error(`[InformationSourceUpload] Failed to stage upload: ${stagingError.message}`);
        response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
        response.sendJson({ error: ErrorCodes.OCR_FAILED, reason: stagingError.message });
        return;
    }

    // The tracking task is what the client polls. It is NOT the OcrPdf worker
    // task (that's created inside the finalizer) — keeping them separate lets us
    // flip the tracking task COMPLETED only AFTER the DB save, so a poll never
    // reports "done" before the source is usable.
    const trackingTask = new TaskDescriptor({
        userId: user.getId(),
        type: taskTypes.OCR_PDF,
        status: taskStatus.IN_PROGRESS,
        executionTarget: taskExecutionTargets.LOCAL,
        completion: 0,
        nextTaskIds: []
    });
    await TaskManager.setTask(trackingTask);

    // Per-task staging key, well clear of the content-addressed store.
    const gcsStagingPath = joinPath("/", PersistenceConstants.TASKS_DIRECTORY, trackingTask.getId(), "original");

    response.statusCode = httpStatus.OK;
    response.sendJson({ taskId: trackingTask.getId(), informationSource: informationSource.toJson() });

    finalizeOcrUploadInBackground({
        trackingTask,
        localStagingFilePath,
        gcsStagingPath,
        informationSourcePath,
        informationSource,
        userId: user.getId(),
        fileSizeBytes
    }).catch(async (unexpectedError) =>
    {
        console.error(`[InformationSourceUpload] Unexpected finalize rejection (task ${trackingTask.getId()}): ${unexpectedError.message}`);
        await markTrackingTaskTerminal(trackingTask, taskStatus.FAILED, unexpectedError.message);
        try { fs.unlinkSync(localStagingFilePath); } catch (_) {}
    });
}

module.exports = { handleInformationSourceUpload };
