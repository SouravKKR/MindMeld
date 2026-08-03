const path = require("path");
const DatabaseConstants = require("../../Constants/DatabaseConstants");

/**
 * SupportAttachmentPolicy
 *
 * The single authority on what a reporter may attach to a support report, and
 * how the resulting object is named in cloud storage.
 *
 * The Report Issue dialog applies the same ceilings client-side, but that copy is
 * purely advisory — a screenshot picker is trivially bypassed, so every rule here
 * is re-checked server-side against the bytes that actually arrived. Mirrors the
 * strict validation already used for admin invoice uploads
 * (Dock/Endpoints/Admin/Deals/UploadDealInvoice.js).
 */
class SupportAttachmentPolicy
{
    static MAXIMUM_ATTACHMENT_COUNT = 5;
    static MAXIMUM_FILE_BYTES = 10 * 1024 * 1024;
    static MAXIMUM_FILE_NAME_LENGTH = 200;

    // Screenshots are the realistic 95% case; PDF covers exported receipts and
    // multi-page reproductions. Everything else is refused rather than stored.
    static ALLOWED_MIME_TYPES = new Set
    ([
        "image/png",
        "image/jpeg",
        "image/jpg",
        "image/webp",
        "image/gif",
        "application/pdf"
    ]);

    // Extension -> MIME, used when the multipart part carries no usable type.
    static MIME_TYPE_BY_EXTENSION =
    {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".gif": "image/gif",
        ".pdf": "application/pdf"
    };

    /**
     * Strips any directory component and every character that is not safe in an
     * object key, then caps the length. A blank result falls back to a constant so
     * the storage path can never collapse to a bare directory.
     *
     * @param {string} rawFileName
     * @returns {string}
     */
    static sanitiseFileName(rawFileName)
    {
        const baseName = String(rawFileName || "attachment").split(/[\\/]/).pop();
        const cleanedName = baseName.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, SupportAttachmentPolicy.MAXIMUM_FILE_NAME_LENGTH);
        return cleanedName.length > 0 ? cleanedName : "attachment";
    }

    /**
     * Resolves the MIME type to validate against, preferring the declared type and
     * falling back to the file extension. Returns an empty string when neither
     * yields anything, which the caller treats as "not allowed".
     *
     * @param {string} declaredMimeType
     * @param {string} fileName
     * @returns {string}
     */
    static resolveMimeType(declaredMimeType, fileName)
    {
        const declared = String(declaredMimeType || "").toLowerCase().split(";")[0].trim();

        if (declared.length > 0)
        {
            return declared;
        }

        const extension = path.extname(String(fileName || "")).toLowerCase();
        return SupportAttachmentPolicy.MIME_TYPE_BY_EXTENSION[extension] || "";
    }

    /**
     * @param {string} mimeType
     * @returns {boolean}
     */
    static isAllowedMimeType(mimeType)
    {
        return SupportAttachmentPolicy.ALLOWED_MIME_TYPES.has(String(mimeType || "").toLowerCase());
    }

    /**
     * @param {number} sizeBytes
     * @returns {boolean}
     */
    static isWithinSizeLimit(sizeBytes)
    {
        const size = Number(sizeBytes);
        return Number.isFinite(size) && size > 0 && size <= SupportAttachmentPolicy.MAXIMUM_FILE_BYTES;
    }

    /**
     * The cloud-storage object key for one attachment. Namespaced by report id so
     * an attachment can only ever be reached by resolving its report first — the
     * download endpoint never trusts a client-supplied path.
     *
     * @param {string} reportId
     * @param {string} safeFileName
     * @returns {string}
     */
    static buildStoragePath(reportId, safeFileName)
    {
        return `${SupportAttachmentPolicy.buildStoragePrefix(reportId)}/${safeFileName}`;
    }

    /**
     * The folder every attachment for one report lives under.
     *
     * Deletion works on this prefix rather than on a stored file list, so a
     * batch interrupted mid-upload is still fully reclaimable — whatever landed
     * is under here, listed at sweep time.
     */
    static buildStoragePrefix(reportId)
    {
        return `${DatabaseConstants.SUPPORT_ATTACHMENT_STORAGE_PREFIX}/${reportId}`;
    }
}

module.exports = SupportAttachmentPolicy;
