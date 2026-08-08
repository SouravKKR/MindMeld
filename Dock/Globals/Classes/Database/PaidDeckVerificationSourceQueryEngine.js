const DatabaseConnector = require("./DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");

/**
 * PaidDeckVerificationSourceQueryEngine — the working set of documents and URLs
 * a paid deck's generated content is checked AGAINST.
 *
 * This is the mutable half of the pair. An administrator adds a source when
 * they have cleared it, and removes it when it stops being the right thing to
 * check against; the deck is verified against whatever is attached at the time
 * the pass runs. SourceLicenceDeclarationQueryEngine is the immutable half and
 * records both acts, so removing a source here never removes the fact that the
 * deck was once checked against it.
 *
 * ATTACHED SOURCES NEVER ENTER GENERATION. They are read only by the
 * source-grounded verification pass, which runs after content already exists
 * and can only raise flags. This is not a detail of the current implementation
 * — it is the reason the feature is safe to have at all. Paid-deck generation
 * accepts one source type (a curriculum or syllabus) and writes content from
 * model knowledge, and the audit trail says so. A verification source that
 * leaked into generation would make that statement false.
 *
 * Rows are keyed on deckId, which is the deck the generation run was launched
 * into — the same identifier PaidDeckProvenanceLinkResolver resolves to. Never
 * the storefront listing id.
 */
class PaidDeckVerificationSourceQueryEngine
{
    /**
     * A deck cannot be checked against an unbounded pile of documents: the pass
     * reads every attached source, and a hundred textbooks would turn one
     * verification run into an unbounded one.
     */
    static MAXIMUM_SOURCES_PER_DECK = 12;

    static async #getCollection()
    {
        const database = await DatabaseConnector.getDatabase();
        return database.collection(DatabaseConstants.PAID_DECK_VERIFICATION_SOURCES_COLLECTION);
    }

    /**
     * The sources a verification run would use right now, oldest first.
     */
    static async findActiveByDeckId(deckId)
    {
        if (typeof deckId !== "string" || deckId.length === 0)
        {
            return [];
        }

        const collection = await PaidDeckVerificationSourceQueryEngine.#getCollection();

        return await collection
            .find({ deckId: deckId, active: true }, { projection: { _id: 0 } })
            .sort({ attachedAt: 1 })
            .toArray();
    }

    static async findById(verificationSourceId)
    {
        if (typeof verificationSourceId !== "string" || verificationSourceId.length === 0)
        {
            return null;
        }

        const collection = await PaidDeckVerificationSourceQueryEngine.#getCollection();

        return await collection.findOne({ id: verificationSourceId }, { projection: { _id: 0 } });
    }

    /**
     * True when this deck already has this exact document or URL attached.
     *
     * Checked on the content hash for a document and on the URL for a link, not
     * on the display name — the same file uploaded twice under two names is one
     * source, and attaching it twice would double its weight in the pass while
     * telling the reviewer nothing new.
     */
    static async isAlreadyAttached(deckId, contentHash, sourceUrl)
    {
        const identityConditions = [];

        if (typeof contentHash === "string" && contentHash.length > 0)
        {
            identityConditions.push({ contentHash: contentHash });
        }

        if (typeof sourceUrl === "string" && sourceUrl.length > 0)
        {
            identityConditions.push({ sourceUrl: sourceUrl, contentHash: "" });
        }

        if (identityConditions.length === 0)
        {
            return false;
        }

        const collection = await PaidDeckVerificationSourceQueryEngine.#getCollection();

        const existing = await collection.findOne(
            { deckId: deckId, active: true, $or: identityConditions },
            { projection: { _id: 0, id: 1 } },
        );

        return existing !== null;
    }

    /**
     * Stores one attached source. The caller has already cleared the licence
     * gate and written the ATTACHED declaration; this only records the working
     * set.
     *
     * @param {object} verificationSource The stored shape (see the codegen class
     *     Common/Classes/PaidDeckVerificationSource.json).
     * @return {Promise<object>}
     */
    static async attach(verificationSource)
    {
        const collection = await PaidDeckVerificationSourceQueryEngine.#getCollection();

        const documentToStore = { ...verificationSource, active: true, detachedAt: 0 };

        await collection.insertOne(documentToStore);
        delete documentToStore._id;

        return documentToStore;
    }

    /**
     * Removes a source from the working set.
     *
     * A soft removal, not a delete. The row is what the declaration log points
     * at, and a dangling declaration whose source row no longer exists cannot
     * show the reader what was detached — only that something was.
     *
     * @return {Promise<boolean>} True when a still-active row was detached.
     */
    static async detach(verificationSourceId, detachedAtMilliseconds)
    {
        if (typeof verificationSourceId !== "string" || verificationSourceId.length === 0)
        {
            return false;
        }

        const collection = await PaidDeckVerificationSourceQueryEngine.#getCollection();

        const updateResult = await collection.updateOne(
            { id: verificationSourceId, active: true },
            { $set: { active: false, detachedAt: detachedAtMilliseconds } },
        );

        return updateResult.modifiedCount > 0;
    }
}

module.exports = PaidDeckVerificationSourceQueryEngine;
