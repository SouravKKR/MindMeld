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
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");
const InformationSourceUploadProgress = require("../../Globals/Constants/InformationSourceUploadProgress");
const OcrTaskPayloadKeys = require("../../Globals/Constants/OcrTaskPayloadKeys");
const { curriculumPlausibility } = require("../../Globals/Enumerations/CurriculumPlausibility");
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
/**
 * Advances the tracking task's own completion to a real, reached milestone.
 *
 * The client renders this value directly, so every number written here must
 * correspond to work that has actually finished — never to elapsed time. The
 * OcrPdf child task reports its own finer-grained completion (which the client
 * reads from the same task tree); these root milestones bracket the phases
 * Dock owns and the child does not: staging the upload, and the verify + save
 * tail that runs after the worker returns.
 *
 * Failures are swallowed. Progress is cosmetic — a Redis blip here must never
 * fail an upload that is otherwise succeeding.
 */
async function updateTrackingTaskCompletion(task, completion)
{
    try
    {
        task.setCompletion(completion);
        await TaskManager.updateTask(task);
    }
    catch (updateError)
    {
        console.warn(`[InformationSourceUpload] Could not update progress for tracking task ${task.getId()}: ${updateError.message}`);
    }
}

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
 * Copies the curriculum verdict OcrPdf measured onto the source about to be
 * saved.
 *
 * The workflow runs in the Agent and cannot touch the source row — it does not
 * exist yet — so it merges the verdict into its own task payload and Dock reads
 * it back here. Deliberately forgiving: a missing or malformed verdict leaves
 * the source at UNKNOWN rather than failing an upload that has already
 * succeeded in every way the user cares about.
 *
 * @param {InformationSource} informationSource
 * @param {string} ocrTaskId
 */
async function applyCurriculumPlausibilityFromOcrTask(informationSource, ocrTaskId)
{
    try
    {
        const completedOcrTask = await TaskManager.getTask(ocrTaskId);
        const payload = completedOcrTask?.getPayload() || {};
        const measuredVerdict = payload[OcrTaskPayloadKeys.CURRICULUM_PLAUSIBILITY];

        if (!Object.values(curriculumPlausibility).includes(measuredVerdict))
        {
            return;
        }

        informationSource.setCurriculumPlausibility(measuredVerdict);

        const measuredReason = payload[OcrTaskPayloadKeys.CURRICULUM_PLAUSIBILITY_REASON];
        informationSource.setCurriculumPlausibilityReason(typeof measuredReason === "string" ? measuredReason : "");
    }
    catch (verdictError)
    {
        console.warn(`[InformationSourceUpload] Could not read the curriculum verdict from OCR task ${ocrTaskId}: ${verdictError.message}`);
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
 *      path). Keeping it off the content path means the content key only ever
 *      holds a fully OCRed object, so a concurrent read can never see a
 *      half-processed one.
 *   2. Enqueue an OcrPdf task ({ ...source, ocrInputPath: <staging> }). The worker
 *      reads the staging key, OCRs, and writes the OCRed PDF to the content path.
 *   3. On success, save the InformationSource + record quota, THEN mark the
 *      tracking task COMPLETED — so the client (which polls the TRACKING task,
 *      not the OcrPdf task) only sees success once the source is fully usable.
 *
 * Rollback discipline:
 *   - OCR failure: OcrPdf writes the content path only on success, so a failure
 *     leaves nothing there — nothing to undo.
 *   - DB save failure (non-duplicate): the content object is left in place. It
 *     sits under this user's own prefix, so the retention sweep reclaims it.
 *   - DB save duplicate-key (E11000): a concurrent same-user request already
 *     inserted the canonical row; the content is valid, so the task is COMPLETED.
 *   - The staging object + local copy are always cleaned up.
 */
async function finalizeOcrUploadInBackground({ trackingTask, localStagingFilePath, gcsStagingPath, informationSourcePath, informationSource, userId, fileSizeBytes })
{
    let bStagedToGcs = false;

    // Per-phase timings. A source that takes minutes to land is indistinguishable
    // from a hung one without them — and with the progress bar now driven by real
    // milestones, the log is the only place the *duration* of each phase is
    // recorded. Cheap enough to keep on unconditionally.
    const finalizeStartMilliseconds = Date.now();
    const elapsedSeconds = (sinceMilliseconds) => ((Date.now() - sinceMilliseconds) / 1000).toFixed(1);

    try
    {
        // Move the original up to the per-task staging key (removes the local copy).
        const stagingStartMilliseconds = Date.now();
        await Persistence.move(
            localStagingFilePath,
            storageTargets.LOCAL_FILE_SYSTEM,
            gcsStagingPath,
            storageTargets.LINODE_OBJECT_STORAGE,
        );
        bStagedToGcs = true;
        console.log(`[InformationSourceUpload] Staged ${fileSizeBytes} bytes to object storage in ${elapsedSeconds(stagingStartMilliseconds)}s (task ${trackingTask.getId()}).`);
        await updateTrackingTaskCompletion(trackingTask, InformationSourceUploadProgress.STAGED);

        // Hand OCR to the worker pool. OcrPdf reads ocrInputPath (staging) and
        // writes the OCRed PDF to the content-addressed path it derives from the
        // source's hash + directory. With the queue enabled this runs on a local
        // or burst worker; in --debug it runs as a local Python subprocess.
        // The mode is the uploader's choice, carried on the source itself. The
        // task still runs when OCR is DISABLED rather than being skipped here:
        // OcrPdf is what moves the staged original onto the content path, and it
        // is also where the curriculum plausibility measurement happens —
        // skipping the task would leave the source unmeasured, and paid-deck
        // mode reads that measurement later.
        const ocrTask = new TaskDescriptor({
            userId: userId,
            type: taskTypes.OCR_PDF,
            executionTarget: taskExecutionTargets.LOCAL,
            payload: {
                ...informationSource.toJson(),
                ocrInputPath: gcsStagingPath
            },
            nextTaskIds: []
        });
        await TaskManager.setTask(ocrTask);

        // Publish the worker task as a child of the tracking task. /Generate/Progress
        // builds its tree by walking nextTaskIds, so this is what puts the OcrPdf
        // workflow's OWN completion (it reports real milestones as it reads, gates
        // and writes) in front of the client. Without the link the client can only
        // see "in progress" and has nothing truthful to draw a bar from.
        //
        // Safe to attach here: nothing ever calls TaskManager.execute on the
        // tracking task, so linking a child does not schedule anything. The tree
        // only becomes terminal once BOTH nodes are, which is exactly the
        // condition the client already waits for.
        trackingTask.setNextTaskIds([ocrTask.getId()]);
        await TaskManager.updateTask(trackingTask);

        const processingStartMilliseconds = Date.now();
        const bOcrSucceeded = await TaskManager.execute(ocrTask, 0, ocrTask, ocrTask.getId());
        console.log(`[InformationSourceUpload] Worker task finished in ${elapsedSeconds(processingStartMilliseconds)}s (task ${trackingTask.getId()}, ocrMode=${informationSource.getOcrMode()}).`);

        if (bOcrSucceeded === false)
        {
            const ocrTaskAfterRun = await TaskManager.getTask(ocrTask.getId());
            const reason = ocrTaskAfterRun?.getPayload()?.error || "OCR task did not complete.";
            throw new Error(reason);
        }

        await updateTrackingTaskCompletion(trackingTask, InformationSourceUploadProgress.PROCESSED);

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

        // Carry OcrPdf's curriculum verdict onto the row before it is persisted.
        // The workflow measures the document's structure and merges the answer
        // into its own task payload; this is the only moment it can be attached,
        // because the source row does not exist until the line below. An absent
        // verdict stays UNKNOWN, which every consumer reads as "not measured".
        await applyCurriculumPlausibilityFromOcrTask(informationSource, ocrTask.getId());

        // OCR done — the OCRed PDF now lives at the content path. Persist the row.
        await InformationSourceQueryEngine.saveInformationSource(informationSource);
        await uploadQuotaManager.record(userId, fileSizeBytes);
        // The upload grew the user's footprint — drop the cached measurement so
        // the next storage-meter read (and the next quota check) re-measures.
        StorageQuotaEnforcer.invalidate(userId);

        console.log(`[InformationSourceUpload] Finalize complete in ${elapsedSeconds(finalizeStartMilliseconds)}s total (task ${trackingTask.getId()}).`);
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
            console.error(`[InformationSourceUpload] Async OCR finalize failed after ${elapsedSeconds(finalizeStartMilliseconds)}s (task ${trackingTask.getId()}): ${error.message}`);
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
 *   - Re-uploading a document this user already holds: 409.
 *   - Otherwise: returns `{ taskId, informationSource }` IMMEDIATELY and
 *     finalizes asynchronously (see finalizeOcrUploadInBackground). The client
 *     polls /Generate/Progress?taskid=... until the tracking task is COMPLETED,
 *     then uses `informationSource`. There is no fast path that skips the
 *     background finalize, because no object is shared between users.
 *
 * OCR is opt-out per upload (`ocrMode` on the metadata). Turning it off does not
 * bypass the finalize: the OcrPdf task still runs, still applies the syllabus
 * plausibility gate, and still lands the original at the content path — it just
 * does not run ocrmypdf. So the invariant below ("if the content object exists,
 * the source is ready") holds identically either way; only the *contents* differ,
 * OCRed vs. exactly the bytes the user sent.
 *
 * Storage contract (per-user, content-named):
 *   - The object path is /InformationSources/<userId>/<sha512(originalBytes)>.
 *     The hash names the object; the user id scopes it. Two users uploading the
 *     same document hold two independent copies, deliberately — see the comment
 *     at the path construction for why cross-user reuse was removed.
 *   - The object at that path is ALWAYS the finished article — the OCRed PDF
 *     when OCR ran, the untouched original when the uploader turned it off. The
 *     original is staged under a separate per-task key and removed once the
 *     content object lands, so "if it exists, it is ready to read" holds by
 *     construction and no reader ever sees a half-processed object.
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
    // An omitted retention mode now defaults to TEMPORARY, not PERMANENT. The
    // shipped client always sends the mode explicitly (it is driven by the
    // "keep permanently" checkbox), so this fallback only fires for a
    // non-conforming caller — and for those, the safe default is the one where
    // the document leaves the platform rather than the one where it is kept
    // indefinitely. Logged loudly because an omitting caller is a client bug
    // whose uploads will now expire.
    if (informationSource.getRetentionMode() === null)
    {
        console.warn(`[InformationSourceUpload] Upload from user ${user.getId()} omitted retentionMode — defaulting to TEMPORARY (expires in ${DatabaseConstants.TEMPORARY_SOURCE_RETENTION_DAYS} days).`);
        informationSource.setRetentionMode(contentRetentionModes.TEMPORARY);
    }

    // OCR is now the uploader's choice (a checkbox in the upload dialog), so the
    // mode arrives on the metadata instead of being forced to ENABLED when the
    // task is built.
    //
    // Decide it from the RAW metadata rather than trusting the parsed model. The
    // generated setOcrMode coerces any unrecognised value to the first enum
    // value — which is DISABLED — so a client sending `ocrMode: 7`, `"yes"` or
    // nothing at all would silently get OCR switched OFF. That is the worst
    // possible default here: the symptom (a generation that finds no text in a
    // scanned book) surfaces far from the cause, and the user never asked for it.
    //
    // So: OCR is disabled ONLY when the request explicitly and validly says so.
    // Everything else — omitted, null, malformed, out of range — is ENABLED,
    // which is what every upload did before this control existed.
    const bClientExplicitlyDisabledOcr = Number(metadataJson?.ocrMode) === ocrModes.DISABLED;
    informationSource.setOcrMode(bClientExplicitlyDisabledOcr ? ocrModes.DISABLED : ocrModes.ENABLED);

    // TEMPORARY now means what it says. Before this, the mode only exempted a
    // source from storage billing and nothing ever removed it — so a TEMPORARY
    // upload was retained forever AND free, the inverse of the intent. Stamping
    // an expiry here is what ExpiredInformationSourceReaper sweeps on; PERMANENT
    // sources keep expiresAt at 0, which the reaper's query excludes.
    if (informationSource.getRetentionMode() === contentRetentionModes.TEMPORARY)
    {
        const retentionMilliseconds = DatabaseConstants.TEMPORARY_SOURCE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
        informationSource.setExpiresAt(Date.now() + retentionMilliseconds);
    }

    const contentAddressedKey = await computeFileSha512Hash(uploadedFilePath);

    informationSource.setUserId(user.getId());
    informationSource.setHash(contentAddressedKey);

    // The durable fact the retention policy derives from. SourceRetentionPolicy
    // computes the deletion date on each sweep rather than stamping one here,
    // because a stamped date goes stale the moment the user subscribes, lapses
    // or resubscribes — so what has to be recorded is when the upload happened,
    // not when it was once predicted to expire.
    informationSource.setUploadedAt(Date.now());

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

    // Per-user storage path. The content hash still names the object — it is a
    // good integrity key and it still detects a user re-uploading their own file
    // — but the path is scoped to the owner, so two users who upload the same
    // textbook now hold two independent copies.
    //
    // This deliberately gives up cross-user deduplication. The storage it saved
    // was negligible (a duplicated textbook costs fractions of a cent per month);
    // what it cost was the legal character of the stored object. One shared copy
    // served to many accounts is the platform reproducing and distributing a
    // work. One private copy per account, held to provide that account its own
    // service, is ordinary hosting. Do not reintroduce a global reuse check here.
    //
    // The trade is real and lands on OCR: the same document uploaded by N users
    // is now OCRed N times.
    const informationSourceDirectory = joinPath("/", PersistenceConstants.INFORMATION_SOURCE_DIRECTORY, user.getId());
    const informationSourcePath = joinPath("/", informationSourceDirectory, contentAddressedKey);

    informationSource.setDirectoryPath(informationSourceDirectory);

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
