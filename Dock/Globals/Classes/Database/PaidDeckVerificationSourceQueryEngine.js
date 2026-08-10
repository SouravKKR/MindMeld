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
 * WHAT A SOURCE IS USED FOR IS PER SOURCE, and is the usageMode field.
 *
 *   VERIFICATION_ONLY — the default, and what every source could do before this
 *       field existed. The document is read only by the source-grounded
 *       verification pass, which runs after content already exists and can only
 *       raise flags. Nothing generated was written from it.
 *   CONTENT_AND_VERIFICATION — the deck's content may also be WRITTEN from this
 *       document. Admissible only under a licence that records a right to create
 *       new material from it (see SourceUsageGate), because the defence for such
 *       content is the licence itself and not independent creation.
 *
 * The two rest on DIFFERENT legal bases and the audit trail reports them
 * separately, per topic. A verification-only source contributes nothing to the
 * independent-creation position; a content source replaces it with an evidenced
 * licence. Merging the two would leave a deck that can claim neither cleanly,
 * which is why the mode lives on the row rather than on the run.
 *
 * Either way, no document reaches a PAID_DECK_* model. Content sources are read
 * by a generator wired to its own ModelPool entry outside that namespace — see
 * the ROUTE BOUNDARY block in ModelPool.py.
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

    /**
     * Matches the maxLength on PaidDeckVerificationSource.sourceNote. Clamped
     * rather than refused: a note is a free-text aid to a human reader, and
     * losing the tail of an over-long one is a better outcome than refusing an
     * edit that was otherwise fine.
     */
    static MAXIMUM_SOURCE_NOTE_LENGTH = 2048;

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
     * Corrects the note or the usage mode on an attached source.
     *
     * The ONLY mutation this class offers besides detach, and it is confined to
     * the two fields an administrator can legitimately revise after the fact: a
     * note they want to add detail to, and a decision about what the source is
     * used for. Everything identifying the document — its hash, its storage
     * path, its licence, who declared it and when — is fixed at attach time and
     * has no setter here, because those are the facts the record exists to hold.
     *
     * The caller writes the corresponding declaration event FIRST. This method
     * deliberately does not write one itself: an update that logged its own
     * history could be called from somewhere that had not checked the licence,
     * and would then produce a log entry asserting a change was permitted.
     *
     * Active rows only. A detached source is a historical fact and editing its
     * note would rewrite what the deck was checked against.
     *
     * @param {string} verificationSourceId
     * @param {{sourceNote: (string|undefined), usageMode: (number|undefined)}} revisions
     * @return {Promise<boolean>} True when a still-active row was updated.
     */
    static async updateDeclaration(verificationSourceId, revisions)
    {
        if (typeof verificationSourceId !== "string" || verificationSourceId.length === 0)
        {
            return false;
        }

        const fieldsToSet = {};

        if (typeof revisions?.sourceNote === "string")
        {
            fieldsToSet.sourceNote = revisions.sourceNote.slice(0, PaidDeckVerificationSourceQueryEngine.MAXIMUM_SOURCE_NOTE_LENGTH);
        }

        if (typeof revisions?.usageMode === "number")
        {
            fieldsToSet.usageMode = revisions.usageMode;
        }

        if (Object.keys(fieldsToSet).length === 0)
        {
            return false;
        }

        const collection = await PaidDeckVerificationSourceQueryEngine.#getCollection();

        const updateResult = await collection.updateOne(
            { id: verificationSourceId, active: true },
            { $set: fieldsToSet },
        );

        return updateResult.modifiedCount > 0;
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
