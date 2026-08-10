const DatabaseConstants = require("../../Constants/DatabaseConstants");
const SupportAttachmentPolicy = require("../Support/SupportAttachmentPolicy");

/**
 * ComplaintEvidencePolicy — where a complainant's evidence is stored, and what
 * it is allowed to be.
 *
 * ── The rules are borrowed; the lifecycle is not ────────────────────────────
 *
 * Everything about WHAT may be uploaded — the MIME allowlist, the size ceiling,
 * the count ceiling, the file-name sanitisation — is delegated to
 * SupportAttachmentPolicy rather than restated. Two copies of an allowlist is
 * one allowlist and one stale allowlist, and the stale one is always the one on
 * the unauthenticated route.
 *
 * What is deliberately NOT shared is the storage prefix, and therefore the
 * lifecycle. Support attachments live under SupportAttachments/, are registered
 * with EphemeralUploadRegistry, and are purged eagerly the moment their ticket
 * is resolved or declined — which is right for a screenshot whose only purpose
 * was to help diagnose one bug.
 *
 * Complaint evidence is the opposite case. It is the proof a notice rested on,
 * and the moment it becomes most likely to be asked for is precisely after the
 * complaint has been disposed of and content has been removed on the strength
 * of it. Purging it on resolution would delete the justification for a takedown
 * and leave the register describing an action nobody can any longer check.
 *
 * So it gets its own prefix, it is never registered with
 * EphemeralUploadRegistry, and SupportAttachmentPurger cannot reach it — not by
 * policy alone, but because the purger walks a ticket's reports and there is no
 * report and no ticket here to walk from. That structural separation is what
 * makes the exclusion hold even if someone later extends the purger without
 * reading this comment.
 */
class ComplaintEvidencePolicy
{
    static MAXIMUM_ATTACHMENT_COUNT = SupportAttachmentPolicy.MAXIMUM_ATTACHMENT_COUNT;
    static MAXIMUM_FILE_BYTES = SupportAttachmentPolicy.MAXIMUM_FILE_BYTES;

    /**
     * @param {string} rawFileName
     * @returns {string}
     */
    static sanitiseFileName(rawFileName)
    {
        return SupportAttachmentPolicy.sanitiseFileName(rawFileName);
    }

    /**
     * @param {string} declaredMimeType
     * @param {string} fileName
     * @returns {string}
     */
    static resolveMimeType(declaredMimeType, fileName)
    {
        return SupportAttachmentPolicy.resolveMimeType(declaredMimeType, fileName);
    }

    /**
     * @param {string} mimeType
     * @returns {boolean}
     */
    static isAllowedMimeType(mimeType)
    {
        return SupportAttachmentPolicy.isAllowedMimeType(mimeType);
    }

    /**
     * @param {number} sizeBytes
     * @returns {boolean}
     */
    static isWithinSizeLimit(sizeBytes)
    {
        return SupportAttachmentPolicy.isWithinSizeLimit(sizeBytes);
    }

    /**
     * The folder one complaint's evidence lives under. Namespaced by complaint
     * id, so an object can only be reached by resolving its complaint first.
     *
     * @param {string} complaintId
     * @returns {string}
     */
    static buildStoragePrefix(complaintId)
    {
        return `${DatabaseConstants.INTELLECTUAL_PROPERTY_COMPLAINT_EVIDENCE_STORAGE_PREFIX}/${complaintId}`;
    }

    /**
     * @param {string} complaintId
     * @param {string} safeFileName
     * @returns {string}
     */
    static buildStoragePath(complaintId, safeFileName)
    {
        return `${ComplaintEvidencePolicy.buildStoragePrefix(complaintId)}/${safeFileName}`;
    }
}

module.exports = ComplaintEvidencePolicy;
