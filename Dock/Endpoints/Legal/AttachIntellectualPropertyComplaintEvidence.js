const fs = require("fs");
const IntellectualPropertyComplaintQueryEngine = require("../../Globals/Classes/Database/IntellectualPropertyComplaintQueryEngine");
const ComplaintEvidencePolicy = require("../../Globals/Classes/Legal/ComplaintEvidencePolicy");
const Persistence = require("../../Globals/Classes/Persistence");
const { storageTargets } = require("../../Globals/Enumerations/StorageTargets");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");

/**
 * POST /Legal/IntellectualPropertyComplaint/Evidence   (multipart)
 *
 * Form fields: complaintId, evidenceUploadToken. Files arrive under the repeated
 * "attachments" field.
 *
 * Lets a complainant attach the proof their complaint rests on — a copy of the
 * work, a registration certificate, a screenshot of the page they are pointing
 * at.
 *
 * ── Only after confirmation ────────────────────────────────────────────────
 *
 * This route is reachable only with the credential minted when the contact
 * address was confirmed. Accepting bytes before that would let anyone put files
 * into the platform's storage by typing a stranger's email into a form, with no
 * one to hold responsible for what was uploaded. The confirmation is what turns
 * an anonymous submission into an attributable one, and only attributable
 * submissions get to write.
 *
 * ── These files outlive the complaint ──────────────────────────────────────
 *
 * Deliberately NOT registered with EphemeralUploadRegistry, and stored under a
 * prefix SupportAttachmentPurger cannot reach. Resolving a complaint must not
 * delete the evidence it was resolved on — see ComplaintEvidencePolicy for the
 * full reasoning. That is the single most important line in this file: every
 * other upload path in this codebase registers for deletion, and copying that
 * habit here would quietly destroy the record on the day the complaint closed.
 */
async function attachIntellectualPropertyComplaintEvidence(request, response)
{
    const body = await request.getBody();
    const files = await request.getFiles();
    const uploadedFiles = normaliseUploadedFiles(files);

    const complaintId = typeof body?.complaintId === "string" ? body.complaintId.trim() : "";
    const evidenceUploadToken = typeof body?.evidenceUploadToken === "string" ? body.evidenceUploadToken.trim() : "";

    const complaint = await IntellectualPropertyComplaintQueryEngine.findByEvidenceUploadToken(complaintId, evidenceUploadToken);

    if (!complaint)
    {
        await discardUploadedFiles(uploadedFiles);
        response.statusCode = httpStatus.FORBIDDEN;
        response.sendJson({ error: ErrorCodes.COMPLAINT_NOT_VERIFIED });
        return;
    }

    if (uploadedFiles.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_BODY, reason: "attachments" });
        return;
    }

    // Counted against what is ALREADY on the complaint, not against this request
    // alone: the window allows several uploads, and a per-request ceiling would
    // be no ceiling at all.
    if (complaint.getAttachments().length + uploadedFiles.length > ComplaintEvidencePolicy.MAXIMUM_ATTACHMENT_COUNT)
    {
        await discardUploadedFiles(uploadedFiles);
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.SUPPORT_TOO_MANY_ATTACHMENTS, maximumCount: ComplaintEvidencePolicy.MAXIMUM_ATTACHMENT_COUNT });
        return;
    }

    // ── Pass 1: validate everything before promoting anything ───────────────
    //
    // Same two-pass shape as SubmitSupportReport, for the same reason: uploading
    // as we validate would strand earlier files in the bucket when a later one
    // is rejected, unreferenced by any record and therefore unreachable by any
    // cleanup — and this path has no retention sweep to catch them.
    const validatedFiles = [];

    for (let attachmentIndex = 0; attachmentIndex < uploadedFiles.length; attachmentIndex++)
    {
        const uploadedFile = uploadedFiles[attachmentIndex];
        const safeFileName = ComplaintEvidencePolicy.sanitiseFileName(uploadedFile.filename);
        const mimeType = ComplaintEvidencePolicy.resolveMimeType(uploadedFile.mimeType, safeFileName);

        if (!ComplaintEvidencePolicy.isAllowedMimeType(mimeType))
        {
            await discardUploadedFiles(uploadedFiles);
            response.statusCode = httpStatus.BAD_REQUEST;
            response.sendJson({ error: ErrorCodes.SUPPORT_INVALID_ATTACHMENT, reason: safeFileName });
            return;
        }

        const fileSizeBytes = resolveFileSizeBytes(uploadedFile);

        if (!ComplaintEvidencePolicy.isWithinSizeLimit(fileSizeBytes))
        {
            await discardUploadedFiles(uploadedFiles);
            response.statusCode = httpStatus.BAD_REQUEST;
            response.sendJson({ error: ErrorCodes.SUPPORT_ATTACHMENT_TOO_LARGE, reason: safeFileName });
            return;
        }

        validatedFiles.push
        ({
            temporaryPath: uploadedFile.path,
            // Prefixed with the position this file takes in the complaint's
            // folder rather than with its index in this request, so a second
            // upload of "Certificate.pdf" cannot overwrite the first.
            storedFileName: `${complaint.getAttachments().length + attachmentIndex}_${safeFileName}`,
            mimeType: mimeType,
            sizeBytes: fileSizeBytes
        });
    }

    // ── Pass 2: promote them ────────────────────────────────────────────────
    const storedAttachments = [];

    for (const validatedFile of validatedFiles)
    {
        const storagePath = ComplaintEvidencePolicy.buildStoragePath(complaint.getId(), validatedFile.storedFileName);

        try
        {
            await Persistence.move(validatedFile.temporaryPath, storageTargets.LOCAL_FILE_SYSTEM, storagePath, storageTargets.LINODE_OBJECT_STORAGE);
        }
        catch (uploadError)
        {
            console.error(`[AttachIntellectualPropertyComplaintEvidence] Upload failed for complaint ${complaint.getReference()}: ${uploadError?.message || uploadError}`);
            await discardStoredAttachments(storedAttachments);
            await discardUploadedFiles(uploadedFiles);

            response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
            response.sendJson({ error: ErrorCodes.GCS_UPLOAD_FAILED });
            return;
        }

        storedAttachments.push
        ({
            fileName: validatedFile.storedFileName,
            storagePath: storagePath,
            mimeType: validatedFile.mimeType,
            sizeBytes: validatedFile.sizeBytes
        });
    }

    const bAttached = await IntellectualPropertyComplaintQueryEngine.attachEvidence(complaint.getId(), storedAttachments);

    if (!bAttached)
    {
        // The bytes are in the bucket but the record that names them is not, so
        // they have to come back out — otherwise they are unreachable by any
        // endpoint and invisible to any cleanup, and unlike the support path
        // there is no retention sweep behind this one to notice.
        await discardStoredAttachments(storedAttachments);

        response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
        response.sendJson({ error: ErrorCodes.DB_SAVE_FAILED });
        return;
    }

    response.sendJson
    ({
        success: true,
        reference: complaint.getReference(),
        attachedCount: storedAttachments.length
    });
}

/**
 * Flattens packetron's multipart file map. A repeated field name collapses to an
 * array while a single occurrence stays a lone object, so both shapes are
 * handled.
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
            console.warn(`[AttachIntellectualPropertyComplaintEvidence] Could not remove the orphaned object ${attachment.storagePath}: ${deleteError?.message || deleteError}`);
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

module.exports = { attachIntellectualPropertyComplaintEvidence };
