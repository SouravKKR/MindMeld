const fs = require("fs");
const { getUser } = require("../Helpers/GetUser");
const SupportTicketQueryEngine = require("../../Globals/Classes/Database/SupportTicketQueryEngine");
const SupportTicketLimits = require("../../Globals/Classes/Support/SupportTicketLimits");
const SupportAttachmentPolicy = require("../../Globals/Classes/Support/SupportAttachmentPolicy");
const SupportTicketQuota = require("../../Globals/Classes/Support/SupportTicketQuota");
const SupportTicketReport = require("../../Globals/Model/SupportTicketReport");
const PublicReportPolicy = require("../../Globals/Classes/Support/PublicReportPolicy");
const CredentialScrubber = require("../../Globals/Classes/Support/CredentialScrubber");
const EphemeralUploadRegistry = require("../../Globals/Classes/Content/EphemeralUploadRegistry");
const Persistence = require("../../Globals/Classes/Persistence");
const TaskDescriptor = require("../../Globals/Classes/Task/TaskDescriptor");
const TaskManager = require("../../Globals/Classes/Task/TaskManager");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");
const { storageTargets } = require("../../Globals/Enumerations/StorageTargets");
const { supportTicketTypes } = require("../../Globals/Enumerations/SupportTicketTypes");
const { supportTicketReportStatus } = require("../../Globals/Enumerations/SupportTicketReportStatus");
const { ephemeralUploadKinds } = require("../../Globals/Enumerations/EphemeralUploadKinds");
const { taskTypes } = require("../../Globals/Enumerations/TaskTypes");
const { taskExecutionTargets } = require("../../Globals/Enumerations/TaskExecutionTargets");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");

const VALID_ISSUE_TYPE_VALUES = new Set(Object.values(supportTicketTypes));
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * POST /Support/Report/Submit         (multipart, login required)
 * POST /Support/Report/SubmitPublic   (multipart, no session)
 *
 * The entry point for the Report Issue dialog, in both of its modes. Form fields
 * carry issueType / description / bNotifyOnResolution (plus contactEmail when
 * nobody is signed in); zero or more files arrive under the repeated
 * "attachments" field. Packetron's multipart parser fills the body and the file
 * map in one pass, so no separate metadata request is needed.
 *
 * The report is stored verbatim and immediately handed to the Agent, which is the
 * only service able to embed text and therefore the only one able to decide which
 * existing ticket (if any) this is a duplicate of. The client is answered 202 as
 * soon as the report is durable — grouping is not something a reporter waits on.
 *
 * Validation order is deliberate: everything cheap and rejectable happens before
 * a single byte is promoted to cloud storage, and the quota is checked before the
 * attachments so a user over their allowance never uploads for nothing.
 *
 * ── The unauthenticated mode ───────────────────────────────────────────────
 *
 * Both routes run this handler, and the handler decides what it is allowed to
 * accept from the session it actually has. With no session, only the types
 * PublicReportPolicy calls public may be filed — in practice the account-access
 * report, whose reporter is by definition the person who cannot sign in — and a
 * contact address is required in place of the account.
 *
 * A signed-in caller hitting the public route is still attributed to their
 * account rather than being treated as anonymous: the session is the better
 * identity when it exists, and dropping it would cost them the quota, the
 * reward and their own "Your reports" view.
 */
async function submitSupportReport(request, response)
{
    const user = await getUser(request);

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

    // An intellectual-property complaint is never a support report. It has its
    // own record, its own deadlines and its own confirmation step, and letting
    // it in through this door would file a legal notice as a bug report — with
    // no complainant particulars, no clock and an attachment lifecycle that
    // deletes the evidence when the ticket closes.
    if (PublicReportPolicy.isIntellectualPropertyComplaint(issueType))
    {
        await discardUploadedFiles(uploadedFiles);
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_BODY, reason: "issueType", useEndpoint: "/Legal/IntellectualPropertyComplaint" });
        return;
    }

    const contactEmail = typeof body?.contactEmail === "string" ? body.contactEmail.trim().toLowerCase() : "";

    if (!user)
    {
        if (!PublicReportPolicy.isAcceptedWithoutAuthentication(issueType))
        {
            await discardUploadedFiles(uploadedFiles);
            response.statusCode = httpStatus.UNAUTHORIZED;
            response.sendJson({ error: ErrorCodes.REPORT_TYPE_NOT_PUBLIC });
            return;
        }

        // Without an account there is no other way to reach this reporter, and
        // an account-access report that cannot be replied to is a dead letter.
        if (!EMAIL_REGEX.test(contactEmail))
        {
            await discardUploadedFiles(uploadedFiles);
            response.statusCode = httpStatus.BAD_REQUEST;
            response.sendJson({ error: ErrorCodes.INVALID_EMAIL });
            return;
        }
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

    // The durable daily allowance is per ACCOUNT, so it only applies when there
    // is one. An anonymous report is bounded by the per-IP plugin on its route
    // instead — counting a hand-typed address as an identity would let anyone
    // exhaust a stranger's allowance by typing their email.
    const quotaOutcome = user
        ? await SupportTicketQuota.check(user.getId())
        : { allowed: true, limit: 0, used: 0, remaining: 0, retryAfterSeconds: 0 };

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
        userId: user ? user.getId() : "",
        userEmail: user ? resolveUserEmail(user) : contactEmail,
        issueType: issueType,
        // An account-access report is the one place a reporter is genuinely
        // likely to type a password — "my password Hunter2 stopped working" —
        // and the description is about to be sent to an embedding model and
        // stored beside every other report. Scrubbed once, here, before it is
        // durable anywhere. Scoped by type rather than applied to everything:
        // see PublicReportPolicy.CREDENTIAL_SCRUB_ISSUE_TYPES.
        description: PublicReportPolicy.requiresCredentialScrub(issueType) ? CredentialScrubber.scrub(description) : description,
        bNotifyOnResolution: user ? body?.bNotifyOnResolution : true,
        createdAt: Date.now(),
        groupingStatus: supportTicketReportStatus.PENDING_GROUPING
    });

    const attachmentOutcome = await storeAttachments(supportTicketReport.getId(), supportTicketReport.getUserId(), uploadedFiles);

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
 * @param {string} userId owner of the upload, or "" for an anonymous report
 * @param {Array<object>} uploadedFiles
 * @returns {Promise<{attachments: Array<object>, error: string|null, reason: string, statusCode: number}>}
 */
async function storeAttachments(reportId, userId, uploadedFiles)
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
            // Empty for an anonymous report. The registry treats that as "no
            // owner", which is correct: there is no account for an erasure
            // request to sweep it under, and the retention window is what
            // reclaims it instead.
            userId: userId.length > 0 ? userId : null,
            retentionDays: DatabaseConstants.SUPPORT_ATTACHMENT_RETENTION_DAYS,
            metadata: { reportId: reportId, attachmentCount: attachments.length }
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
    // Some report types are never clustered — see PublicReportPolicy. They are
    // not "ungrouped by failure", so the report is left in its pending state
    // rather than flagged, and nothing is queued.
    if (PublicReportPolicy.isGroupingExempt(supportTicketReport.getIssueType()))
    {
        return;
    }

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
