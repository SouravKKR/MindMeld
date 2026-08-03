const fs = require("fs");
const { getUser } = require("../Helpers/GetUser");
const SupportTicketQueryEngine = require("../../Globals/Classes/Database/SupportTicketQueryEngine");
const SupportTicketLimits = require("../../Globals/Classes/Support/SupportTicketLimits");
const SupportAttachmentPolicy = require("../../Globals/Classes/Support/SupportAttachmentPolicy");
const SupportTicketQuota = require("../../Globals/Classes/Support/SupportTicketQuota");
const SupportTicketReport = require("../../Globals/Model/SupportTicketReport");
const Persistence = require("../../Globals/Classes/Persistence");
const TaskDescriptor = require("../../Globals/Classes/Task/TaskDescriptor");
const TaskManager = require("../../Globals/Classes/Task/TaskManager");
const { storageTargets } = require("../../Globals/Enumerations/StorageTargets");
const { supportTicketTypes } = require("../../Globals/Enumerations/SupportTicketTypes");
const { supportTicketReportStatus } = require("../../Globals/Enumerations/SupportTicketReportStatus");
const { taskTypes } = require("../../Globals/Enumerations/TaskTypes");
const { taskExecutionTargets } = require("../../Globals/Enumerations/TaskExecutionTargets");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");

const VALID_ISSUE_TYPE_VALUES = new Set(Object.values(supportTicketTypes));

/**
 * POST /Support/Report/Submit   (multipart, MULTIPART_FORM_DATA)
 *
 * The single entry point for the Report Issue dialog. Form fields carry
 * issueType / description / bNotifyOnResolution; zero or more files arrive under
 * the repeated "attachments" field. Packetron's multipart parser fills the body
 * and the file map in one pass, so no separate metadata request is needed.
 *
 * The report is stored verbatim and immediately handed to the Agent, which is the
 * only service able to embed text and therefore the only one able to decide which
 * existing ticket (if any) this is a duplicate of. The client is answered 202 as
 * soon as the report is durable — grouping is not something a reporter waits on.
 *
 * Validation order is deliberate: everything cheap and rejectable happens before
 * a single byte is promoted to cloud storage, and the quota is checked before the
 * attachments so a user over their allowance never uploads for nothing.
 */
async function submitSupportReport(request, response)
{
    const user = await getUser(request);

    if (!user)
    {
        response.statusCode = httpStatus.UNAUTHORIZED;
        response.sendJson({ error: ErrorCodes.INVALID_REQUEST });
        return;
    }

    const body = await request.getBody();
    const files = await request.getFiles();
    const uploadedFiles = normaliseUploadedFiles(files);

    const issueType = Number(body?.issueType);

    if (!Number.isInteger(issueType) || !VALID_ISSUE_TYPE_VALUES.has(issueType))
    {
        await discardUploadedFiles(uploadedFiles);
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_BODY, reason: "issueType" });
        return;
    }

    const description = String(body?.description ?? "").trim();

    if (description.length < SupportTicketLimits.MINIMUM_DESCRIPTION_LENGTH)
    {
        await discardUploadedFiles(uploadedFiles);
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson
        ({
            error: ErrorCodes.INVALID_BODY,
            reason: "descriptionTooShort",
            minimumLength: SupportTicketLimits.MINIMUM_DESCRIPTION_LENGTH
        });
        return;
    }

    // Rejected rather than truncated: silently dropping the tail would leave the
    // reporter believing they had sent detail that never arrived.
    if (description.length > SupportTicketLimits.MAXIMUM_DESCRIPTION_LENGTH)
    {
        await discardUploadedFiles(uploadedFiles);
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson
        ({
            error: ErrorCodes.INVALID_BODY,
            reason: "descriptionTooLong",
            maximumLength: SupportTicketLimits.MAXIMUM_DESCRIPTION_LENGTH
        });
        return;
    }

    const quotaOutcome = await SupportTicketQuota.check(user.getId());

    if (!quotaOutcome.allowed)
    {
        await discardUploadedFiles(uploadedFiles);
        response.statusCode = httpStatus.TOO_MANY_REQUESTS;
        response.sendJson
        ({
            error: ErrorCodes.SUPPORT_QUOTA_EXCEEDED,
            limit: quotaOutcome.limit,
            used: quotaOutcome.used,
            retryAfterSeconds: quotaOutcome.retryAfterSeconds
        });
        return;
    }

    if (uploadedFiles.length > SupportAttachmentPolicy.MAXIMUM_ATTACHMENT_COUNT)
    {
        await discardUploadedFiles(uploadedFiles);
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.SUPPORT_TOO_MANY_ATTACHMENTS, maximumCount: SupportAttachmentPolicy.MAXIMUM_ATTACHMENT_COUNT });
        return;
    }

    const supportTicketReport = new SupportTicketReport
    ({
        userId: user.getId(),
        userEmail: resolveUserEmail(user),
        issueType: issueType,
        description: description,
        bNotifyOnResolution: body?.bNotifyOnResolution,
        createdAt: Date.now(),
        groupingStatus: supportTicketReportStatus.PENDING_GROUPING
    });

    const attachmentOutcome = await storeAttachments(supportTicketReport.getId(), uploadedFiles);

    if (attachmentOutcome.error !== null)
    {
        await discardUploadedFiles(uploadedFiles);
        response.statusCode = attachmentOutcome.statusCode;
        response.sendJson({ error: attachmentOutcome.error, reason: attachmentOutcome.reason });
        return;
    }

    supportTicketReport.setAttachments(attachmentOutcome.attachments);

    const insertOutcome = await SupportTicketQueryEngine.insertReport(supportTicketReport);

    if (!insertOutcome.saved)
    {
        // The attachments are already in the bucket at this point but the row that
        // would reference them does not exist, so they have to come back out —
        // otherwise they are unreachable by any endpoint and invisible to any
        // cleanup, forever.
        await discardStoredAttachments(attachmentOutcome.attachments);

        response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
        response.sendJson({ error: ErrorCodes.DB_SAVE_FAILED });
        return;
    }

    // Answer before grouping. The reporter's confirmation must not depend on an
    // LLM round trip, and the "Your reports" view reads the pending state fine.
    response.statusCode = httpStatus.ACCEPTED;
    response.sendJson
    ({
        success: true,
        reportId: supportTicketReport.getId(),
        remaining: Math.max(0, quotaOutcome.remaining - 1)
    });

    await queueDeduplication(supportTicketReport);
}

/**
 * Normalises packetron's multipart file map into a flat array.
 *
 * Under MULTIPART_FORM_DATA each stored file is an object
 * { path, filename, encoding, mimeType, size, truncated } — NOT a bare path, and
 * a repeated field name collapses into an array while a single occurrence stays a
 * lone object. Both shapes have to be handled.
 *
 * Because each entry carries its own filename and mimeType from the part headers,
 * nothing has to be correlated by index against parallel form fields.
 *
 * @param {object} files
 * @returns {Array<object>}
 */
function normaliseUploadedFiles(files)
{
    const uploadedFiles = [];

    for (const fieldName of ["attachments", "attachment"])
    {
        const fieldValue = files?.[fieldName];

        if (Array.isArray(fieldValue))
        {
            uploadedFiles.push(...fieldValue);
        }
        else if (fieldValue)
        {
            uploadedFiles.push(fieldValue);
        }
    }

    return uploadedFiles.filter(uploadedFile => uploadedFile && typeof uploadedFile.path === "string" && uploadedFile.path.length > 0);
}

/**
 * Removes temporary multipart files from local disk. Called on every rejection
 * path so a refused submission never leaves bytes behind.
 *
 * @param {Array<object>} uploadedFiles
 * @returns {Promise<void>}
 */
async function discardUploadedFiles(uploadedFiles)
{
    for (const uploadedFile of uploadedFiles)
    {
        try
        {
            fs.unlinkSync(uploadedFile.path);
        }
        catch (cleanupError)
        {
            // A missing temp file is the expected outcome after a successful move.
        }
    }
}

/**
 * Validates and promotes each attachment to cloud storage.
 *
 * Every rule is re-checked here even though the dialog applies the same ceilings:
 * the client-side guard is a convenience, not a control. The declared file name
 * and MIME type come from the browser's multipart part headers and are treated as
 * untrusted hints — the name is sanitised before it becomes part of an object key,
 * and the size is taken from the bytes actually written to disk rather than from
 * anything the client claimed.
 *
 * @param {string} reportId
 * @param {Array<object>} uploadedFiles
 * @returns {Promise<{attachments: Array<object>, error: string|null, reason: string, statusCode: number}>}
 */
async function storeAttachments(reportId, uploadedFiles)
{
    const attachments = [];

    if (uploadedFiles.length === 0)
    {
        return { attachments: attachments, error: null, reason: "", statusCode: httpStatus.OK };
    }

    // ── Pass 1: validate every file BEFORE promoting any of them ────────────
    //
    // Validating and uploading in one pass would leave earlier attachments
    // stranded in the bucket when a later one is rejected: the request returns
    // 400, no report row is ever inserted, and those objects become unreferenced
    // and unreachable forever. Since a rejection costs no quota, that is a leak
    // any logged-in user could trigger at will.
    const validatedFiles = [];

    for (let attachmentIndex = 0; attachmentIndex < uploadedFiles.length; attachmentIndex++)
    {
        const uploadedFile = uploadedFiles[attachmentIndex];
        const safeFileName = SupportAttachmentPolicy.sanitiseFileName(uploadedFile.filename);
        const mimeType = SupportAttachmentPolicy.resolveMimeType(uploadedFile.mimeType, safeFileName);

        if (!SupportAttachmentPolicy.isAllowedMimeType(mimeType))
        {
            return { attachments: [], error: ErrorCodes.SUPPORT_INVALID_ATTACHMENT, reason: safeFileName, statusCode: httpStatus.BAD_REQUEST };
        }

        const fileSizeBytes = resolveFileSizeBytes(uploadedFile);

        if (fileSizeBytes <= 0)
        {
            return { attachments: [], error: ErrorCodes.SUPPORT_INVALID_ATTACHMENT, reason: safeFileName, statusCode: httpStatus.BAD_REQUEST };
        }

        if (!SupportAttachmentPolicy.isWithinSizeLimit(fileSizeBytes))
        {
            return { attachments: [], error: ErrorCodes.SUPPORT_ATTACHMENT_TOO_LARGE, reason: safeFileName, statusCode: httpStatus.BAD_REQUEST };
        }

        validatedFiles.push
        ({
            temporaryPath: uploadedFile.path,
            // Prefixed with the index so two attachments sharing a file name (a
            // very common case with "Screenshot.png") cannot overwrite each other
            // inside the report's storage folder.
            storedFileName: `${attachmentIndex}_${safeFileName}`,
            mimeType: mimeType,
            sizeBytes: fileSizeBytes
        });
    }

    // ── Pass 2: promote them ────────────────────────────────────────────────
    for (const validatedFile of validatedFiles)
    {
        const storagePath = SupportAttachmentPolicy.buildStoragePath(reportId, validatedFile.storedFileName);

        try
        {
            await Persistence.move(validatedFile.temporaryPath, storageTargets.LOCAL_FILE_SYSTEM, storagePath, storageTargets.LINODE_OBJECT_STORAGE);
        }
        catch (uploadError)
        {
            console.error(`[SubmitSupportReport] Attachment upload failed for report ${reportId}: ${uploadError?.message || uploadError}`);

            // A storage failure part-way through still leaves earlier objects
            // behind, so clean them up before giving up. Best-effort: a failed
            // delete is logged and does not mask the original error.
            await discardStoredAttachments(attachments);

            return { attachments: [], error: ErrorCodes.GCS_UPLOAD_FAILED, reason: uploadError?.message || "", statusCode: httpStatus.INTERNAL_SERVER_ERROR };
        }

        attachments.push
        ({
            fileName: validatedFile.storedFileName,
            storagePath: storagePath,
            mimeType: validatedFile.mimeType,
            sizeBytes: validatedFile.sizeBytes
        });
    }

    // Backstop deletion record. Resolving or declining the ticket purges these
    // eagerly (SupportAttachmentPurger); this registration is what catches the
    // tickets that are never actioned — before it, an attachment on an
    // abandoned report was kept forever. Registered once for the report's whole
    // folder rather than per file, so a partially-written batch is still fully
    // reclaimable.
    if (attachments.length > 0)
    {
        await EphemeralUploadRegistry.register
        ({
            storagePrefix: SupportAttachmentPolicy.buildStoragePrefix(reportId),
            kind: ephemeralUploadKinds.SUPPORT_ATTACHMENT,
            userId: userId,
            retentionDays: DatabaseConstants.SUPPORT_ATTACHMENT_RETENTION_DAYS,
            metadata: { reportId: reportId, attachmentCount: attachments.length },
        });
    }

    return { attachments: attachments, error: null, reason: "", statusCode: httpStatus.OK };
}

/**
 * Deletes attachments already promoted to cloud storage, so a submission that
 * fails after some uploads succeeded leaves nothing unreferenced in the bucket.
 *
 * @param {Array<object>} attachments
 * @returns {Promise<void>}
 */
async function discardStoredAttachments(attachments)
{
    for (const attachment of attachments)
    {
        try
        {
            await Persistence.delete(attachment.storagePath, storageTargets.LINODE_OBJECT_STORAGE);
        }
        catch (deleteError)
        {
            console.warn(`[SubmitSupportReport] Could not remove the orphaned attachment ${attachment.storagePath}: ${deleteError?.message || deleteError}`);
        }
    }
}

/**
 * The byte count packetron recorded while writing the part, falling back to the
 * file on disk. Never the client's word.
 *
 * @param {object} uploadedFile
 * @returns {number}
 */
function resolveFileSizeBytes(uploadedFile)
{
    const recordedSize = Number(uploadedFile.size);

    if (Number.isFinite(recordedSize) && recordedSize > 0)
    {
        return recordedSize;
    }

    try
    {
        return fs.statSync(uploadedFile.path).size;
    }
    catch (statError)
    {
        return 0;
    }
}

/**
 * @param {object} user
 * @returns {string}
 */
function resolveUserEmail(user)
{
    const additionalData = typeof user.getAdditionalData === "function" ? user.getAdditionalData() : null;
    return String(additionalData?.email ?? "");
}

/**
 * Hands the stored report to the Agent for deduplication. Failure here is not
 * fatal to the submission — the report is already durable — but it must not be
 * silent: the report is flagged so the admin sees an ungrouped submission rather
 * than losing it.
 *
 * @param {SupportTicketReport} supportTicketReport
 * @returns {Promise<void>}
 */
async function queueDeduplication(supportTicketReport)
{
    const deduplicationTask = new TaskDescriptor
    ({
        type: taskTypes.DEDUPLICATE_SUPPORT_TICKET,
        executionTarget: taskExecutionTargets.LOCAL,
        userId: supportTicketReport.getUserId(),
        payload: { reportId: supportTicketReport.getId() },
        nextTaskIds: []
    });

    try
    {
        await TaskManager.setTask(deduplicationTask);
    }
    catch (queueError)
    {
        console.error(`[SubmitSupportReport] Could not queue deduplication for report ${supportTicketReport.getId()}: ${queueError?.message || queueError}`);
        await SupportTicketQueryEngine.markReportGroupingFailed(supportTicketReport.getId());
        return;
    }

    TaskManager.execute(deduplicationTask).catch(async (executionError) =>
    {
        console.error(`[SubmitSupportReport] Deduplication failed for report ${supportTicketReport.getId()}:`, executionError);
        try
        {
            await SupportTicketQueryEngine.markReportGroupingFailed(supportTicketReport.getId());
        }
        catch (markError)
        {
            console.error(`[SubmitSupportReport] Could not flag report ${supportTicketReport.getId()} as ungrouped: ${markError?.message || markError}`);
        }
    });
}

module.exports = { submitSupportReport };
