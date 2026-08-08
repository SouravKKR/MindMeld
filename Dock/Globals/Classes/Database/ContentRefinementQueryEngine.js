const crypto = require("crypto");
const DatabaseConnector = require("./DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");

/**
 * ContentRefinementQueryEngine — the insert-only record of every AI-assisted
 * correction a person applied to generated content.
 *
 * Insert-and-read only, for the same reason GenerationProvenanceQueryEngine is:
 * the record's whole value is that it can be produced later as evidence of what
 * was changed, on whose instruction, against which source, under which declared
 * licence — and a record that could be edited afterwards evidences nothing.
 * There is no update method and no delete method, and none should be added. A
 * refinement that was itself wrong is corrected by refining again, which files a
 * second record; the first stays.
 *
 * Why this is NOT a field on the provenance record. Provenance is scoped to paid
 * decks by design, and says so: a user's own generated decks get nothing there,
 * because building an audit dossier for every private generation would be
 * surveillance dressed up as diligence. Refinement, however, is available to
 * anyone with the AI-generation entitlement, on any deck they own — so filing
 * refinements inside provenance would have recorded them for the small minority
 * of decks that are paid and dropped them for everyone else. Since the reason
 * the record exists is the LICENCE DECLARATION attached to a reference source,
 * dropping the majority case would have defeated the point.
 *
 * The two are still joined where it matters: a refinement that answered a
 * verification flag carries the mainTaskId and flagIndex it answered, so an
 * auditor reading a paid deck's provenance can reach every correction made to
 * it, and the append-only doctrine on the provenance side stays intact.
 *
 * This collection is also what holds an attached proof source against deletion.
 * SourceRetentionPolicy asks it which content hashes are cited as a licensing
 * basis, and the reaper leaves those alone.
 */
class ContentRefinementQueryEngine
{
    /**
     * Appends one applied refinement.
     *
     * Called only AFTER the content write succeeded. A record written before the
     * write would claim a change that may not have landed, and this collection's
     * only job is to be trustworthy about what actually happened.
     *
     * @param {object} refinementDetails
     * @return {Promise<object>} The stored document.
     */
    static async record(refinementDetails)
    {
        const collection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.CONTENT_REFINEMENTS_COLLECTION);

        const refinementDocument =
        {
            refinementId: crypto.randomUUID(),

            // Which content changed.
            deckId: refinementDetails.deckId || "",
            entityId: refinementDetails.entityId || "",
            entityTypeName: refinementDetails.entityTypeName || "",
            targetKindName: refinementDetails.targetKindName || "",

            // Who owns it and who acted. Usually the same person; deliberately
            // two fields because an administrator answering a verification flag
            // edits a deck owned by whoever ran the generation, and "who changed
            // this" and "whose deck is it" are different questions.
            ownerUserId: refinementDetails.ownerUserId || "",
            actorUserId: refinementDetails.actorUserId || "",

            // What was asked for, and what the model did about it.
            instruction: ContentRefinementQueryEngine.#clampString(refinementDetails.instruction, 4000),
            summary: ContentRefinementQueryEngine.#clampString(refinementDetails.summary, 2000),
            concerns: ContentRefinementQueryEngine.#clampString(refinementDetails.concerns, 2000),
            modelIdentifier: refinementDetails.modelIdentifier || "",

            // The licensing basis. sourceHash names the retained bytes and is
            // what the retention hold keys on; a refinement with no attached
            // source leaves all of these empty and holds nothing.
            informationSourceId: refinementDetails.informationSourceId || "",
            sourceHash: refinementDetails.sourceHash || "",
            sourceName: ContentRefinementQueryEngine.#clampString(refinementDetails.sourceName, 256),
            sourceUrl: ContentRefinementQueryEngine.#clampString(refinementDetails.sourceUrl, 2048),
            licenceType: typeof refinementDetails.licenceType === "number" ? refinementDetails.licenceType : 0,
            licenceNote: ContentRefinementQueryEngine.#clampString(refinementDetails.licenceNote, 1024),

            // What the provider observed itself consulting — not what the model
            // said it consulted. See AutomationResponse.get_grounding_sources.
            consultedUrls: Array.isArray(refinementDetails.consultedUrls)
                ? refinementDetails.consultedUrls.slice(0, 32).map(url => ContentRefinementQueryEngine.#clampString(url, 2048))
                : [],

            // Diagram refinements only.
            visionReviewOutcome: ContentRefinementQueryEngine.#clampString(refinementDetails.visionReviewOutcome, 2000),
            visualMethodName: refinementDetails.visualMethodName || "",

            // Content hashes rather than content. The record has to show that
            // something specific changed without becoming a second copy of the
            // deck — and a hash is enough to prove a later state is or is not
            // the one this refinement produced.
            beforeContentHash: refinementDetails.beforeContentHash || "",
            afterContentHash: refinementDetails.afterContentHash || "",

            // Set when this refinement answered a paid-deck verification flag.
            mainTaskId: refinementDetails.mainTaskId || null,
            flagIndex: typeof refinementDetails.flagIndex === "number" ? refinementDetails.flagIndex : null,

            createdAt: Date.now(),
        };

        await collection.insertOne(refinementDocument);
        delete refinementDocument._id;

        return refinementDocument;
    }

    /**
     * Every refinement applied to one deck, oldest first — the order a reader
     * needs to follow what happened to a passage over time.
     */
    static async findAllByDeckId(deckId)
    {
        if (typeof deckId !== "string" || deckId.length === 0)
        {
            return [];
        }

        const collection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.CONTENT_REFINEMENTS_COLLECTION);

        return await collection
            .find({ deckId: deckId }, { projection: { _id: 0 } })
            .sort({ createdAt: 1 })
            .toArray();
    }

    static async findById(refinementId)
    {
        if (typeof refinementId !== "string" || refinementId.length === 0)
        {
            return null;
        }

        const collection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.CONTENT_REFINEMENTS_COLLECTION);

        return await collection.findOne({ refinementId: refinementId }, { projection: { _id: 0 } });
    }

    /**
     * The content hashes of every source this user has cited as a licensing
     * basis. SourceRetentionPolicy holds these against deletion.
     *
     * Scoped to one user because that is how the reaper sweeps — per user, with
     * a policy resolved from that user's subscription. A hash is only held for
     * the account that cited it; another account's identical upload is its own
     * copy under its own retention rules.
     *
     * @param {string} userId
     * @return {Promise<Set<string>>}
     */
    static async findReferencedSourceHashesForUser(userId)
    {
        if (typeof userId !== "string" || userId.length === 0)
        {
            return new Set();
        }

        const collection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.CONTENT_REFINEMENTS_COLLECTION);

        // Matched on ownerUserId OR actorUserId: an administrator's correction
        // to someone else's deck cites a source the administrator uploaded, and
        // the hold has to follow the account the file actually lives in.
        const referencingDocuments = await collection
            .find(
                {
                    sourceHash: { $nin: [null, ""] },
                    $or: [{ ownerUserId: userId }, { actorUserId: userId }],
                },
                { projection: { _id: 0, sourceHash: 1 } },
            )
            .toArray();

        return new Set(referencingDocuments.map(document => document.sourceHash).filter(Boolean));
    }

    static #clampString(value, maximumLength)
    {
        if (typeof value !== "string")
        {
            return "";
        }

        return value.length > maximumLength ? value.substring(0, maximumLength) : value;
    }
}

module.exports = ContentRefinementQueryEngine;
