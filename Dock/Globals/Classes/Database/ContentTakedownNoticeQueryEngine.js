const crypto = require("crypto");
const DatabaseConnector = require("./DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");

/**
 * ContentTakedownNoticeQueryEngine — the append-only register of content
 * takedowns actioned against uploaded documents.
 *
 * Deliberately insert-and-read only. There is no update or delete method, and
 * none should be added: the register's whole value is that it can be produced
 * later as evidence of what was removed, when, on whose notice and by which
 * administrator. A mutable record proves nothing.
 *
 * This complements rather than replaces AdminActionAuditor, which records that
 * a privileged HTTP request happened (actor, endpoint, status, IP) for every
 * admin route. What it cannot capture is the content-specific outcome — which
 * hash, which notice reference, how many tenants were affected and how much
 * derived material was purged. That is what a rightsholder or a regulator asks
 * for, so it is recorded here explicitly.
 */
class ContentTakedownNoticeQueryEngine
{
    /**
     * Appends a takedown record. Returns the stored document.
     *
     * @param {object} noticeDetails
     * @param {string} noticeDetails.contentHash - The sha512 key that was purged.
     * @param {string} noticeDetails.noticeReference - The rightsholder's reference for the notice.
     * @param {string} noticeDetails.reason - Free-text justification recorded by the administrator.
     * @param {string|null} noticeDetails.actorUserId - The administrator who actioned it.
     * @param {string|null} noticeDetails.actorEmail - Their email, denormalised so the record stands alone.
     * @param {number} noticeDetails.rowsRemoved - Information-source rows deleted across all tenants.
     * @param {string[]} noticeDetails.affectedUserIds - Tenants whose row referenced the content.
     * @param {boolean} noticeDetails.bContentRemoved - Whether the stored blob was deleted.
     * @param {number} noticeDetails.embeddingChunksRemoved - Verbatim text chunks purged.
     * @param {number} noticeDetails.figuresRemoved - Cached figure extractions purged.
     * @param {string|null} noticeDetails.storageError - Storage failure, when the cascade was incomplete.
     * @return {Promise<object>} The recorded notice.
     */
    static async record(noticeDetails)
    {
        const collection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.CONTENT_TAKEDOWN_NOTICES_COLLECTION);

        const noticeDocument =
        {
            id: crypto.randomUUID(),
            contentHash: noticeDetails.contentHash,
            noticeReference: noticeDetails.noticeReference,
            reason: noticeDetails.reason,
            actorUserId: noticeDetails.actorUserId || null,
            actorEmail: noticeDetails.actorEmail || null,
            rowsRemoved: noticeDetails.rowsRemoved || 0,
            affectedUserIds: noticeDetails.affectedUserIds || [],
            contentRemoved: noticeDetails.bContentRemoved === true,
            embeddingChunksRemoved: noticeDetails.embeddingChunksRemoved || 0,
            figuresRemoved: noticeDetails.figuresRemoved || 0,
            storageError: noticeDetails.storageError || null,
            actionedAt: Date.now()
        };

        await collection.insertOne(noticeDocument);

        // The register outlives the request, so a takedown is never only
        // visible in the server log.
        console.log(
            `[ContentTakedownNotice] Actioned notice ${noticeDocument.noticeReference} for hash ${noticeDocument.contentHash} — ` +
            `${noticeDocument.rowsRemoved} row(s) across ${noticeDocument.affectedUserIds.length} tenant(s), ` +
            `${noticeDocument.embeddingChunksRemoved} chunk(s), ${noticeDocument.figuresRemoved} figure(s).`,
        );

        return noticeDocument;
    }

    /**
     * Lists recorded notices, newest first.
     * @param {number} limit - Maximum records to return.
     * @param {number} offset - Records to skip.
     * @return {Promise<{notices: object[], totalCount: number}>}
     */
    static async list(limit, offset)
    {
        const collection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.CONTENT_TAKEDOWN_NOTICES_COLLECTION);

        const totalCount = await collection.countDocuments({});
        const notices = await collection.find({}, { projection: { _id: 0 } })
            .sort({ actionedAt: -1 })
            .skip(offset)
            .limit(limit)
            .toArray();

        return { notices: notices, totalCount: totalCount };
    }

    /**
     * Returns every notice recorded against a content hash. Lets an operator
     * confirm whether content was already taken down before re-actioning it.
     * @param {string} contentHash
     * @return {Promise<object[]>}
     */
    static async findByContentHash(contentHash)
    {
        const collection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.CONTENT_TAKEDOWN_NOTICES_COLLECTION);
        return await collection.find({ contentHash: contentHash }, { projection: { _id: 0 } }).sort({ actionedAt: -1 }).toArray();
    }
}

module.exports = ContentTakedownNoticeQueryEngine;
