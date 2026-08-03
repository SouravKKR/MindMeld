const crypto = require("crypto");
const DatabaseConnector = require("./DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");

/**
 * GenerationProvenanceQueryEngine — the insert-only record of how one paid deck
 * was generated.
 *
 * Deliberately insert-and-read only, modelled on
 * ContentTakedownNoticeQueryEngine. There is no update method and no delete
 * method, and none should be added. The record's entire value is that it can be
 * produced later as evidence of what the pipeline did, in what order, with which
 * models, from which declared source — and a record that could be edited after
 * the fact evidences nothing. If a run needs correcting, re-run it and insert a
 * second record; do not mutate the first.
 *
 * Scope. PAID decks only. A user's own AI-generated decks get nothing here:
 * they are the user's private content, the platform is not selling them, and
 * building a per-deck audit dossier for every user generation would be
 * surveillance dressed up as diligence.
 *
 * One document per deck, not per chunk. A per-chunk trail would be unreadable
 * and would grow without bound; the question this record answers is about the
 * deck ("what went into the thing you sold me"), so the deck is the unit.
 */
class GenerationProvenanceQueryEngine
{
    /**
     * Appends the provenance record for one generated paid deck.
     *
     * Idempotent on mainTaskId: a re-run of the persistence step for the same
     * generation does not create a second record. That is an insert guard, not
     * an update — the stored document is never modified.
     *
     * @param {object} provenanceDetails
     * @return {Promise<object|null>} The stored document, or null when one already existed.
     */
    static async record(provenanceDetails)
    {
        const collection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.GENERATION_PROVENANCE_COLLECTION);

        const existingRecord = await collection.findOne({ mainTaskId: provenanceDetails.mainTaskId }, { projection: { _id: 0, id: 1 } });
        if (existingRecord)
        {
            console.log(`[GenerationProvenance] A record already exists for run ${provenanceDetails.mainTaskId} — not inserting a second.`);
            return null;
        }

        const provenanceDocument =
        {
            id: crypto.randomUUID(),
            mainTaskId: provenanceDetails.mainTaskId,
            deckId: provenanceDetails.deckId,
            deckName: provenanceDetails.deckName || null,
            generatedByUserId: provenanceDetails.generatedByUserId || null,

            // The source declaration. This is the section the audit report leans
            // on hardest: what was uploaded, its content hash, the type it was
            // declared as, and the standing fact that the mode accepted nothing
            // else.
            sources: provenanceDetails.sources || [],
            declaredSourceTypeNames: provenanceDetails.declaredSourceTypeNames || [],
            acceptedSourceTypeName: provenanceDetails.acceptedSourceTypeName || null,
            providedDocumentsAccepted: false,

            // The ordered action trail, merged from the per-stage logs the Agent
            // wrote and sorted by timestamp.
            actions: provenanceDetails.actions || [],

            // Verification outcome as it stood at persistence time. Resolutions
            // recorded later are appended by recordFlagResolution, never by
            // editing these.
            verification: provenanceDetails.verification || null,
            coverageReconciliation: provenanceDetails.coverageReconciliation || null,

            // Publication state. Written once at publish time by recordPublication.
            publishedByUserId: null,
            publishedAt: null,

            flagResolutions: [],

            recordedAt: Date.now()
        };

        await collection.insertOne(provenanceDocument);

        console.log(
            `[GenerationProvenance] Recorded run ${provenanceDocument.mainTaskId} for deck ${provenanceDocument.deckId} — ` +
            `${provenanceDocument.actions.length} action(s), ${provenanceDocument.sources.length} declared source(s).`,
        );

        return provenanceDocument;
    }

    /**
     * Appends a flag resolution. This is an APPEND to an array, never an edit of
     * the flag it refers to — the original flag stays exactly as verification
     * raised it, and the resolution sits beside it with its own actor and
     * timestamp. Reading the pair tells you both what was found and what was
     * decided, which is the point.
     *
     * @return {Promise<boolean>} True when a record existed to append to.
     */
    static async recordFlagResolution(deckId, resolutionDetails)
    {
        const collection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.GENERATION_PROVENANCE_COLLECTION);

        const updateResult = await collection.updateOne(
            { deckId: deckId },
            {
                $push:
                {
                    flagResolutions:
                    {
                        flagIndex: resolutionDetails.flagIndex,
                        resolution: resolutionDetails.resolution,
                        note: resolutionDetails.note || null,
                        actorUserId: resolutionDetails.actorUserId || null,
                        resolvedAt: Date.now()
                    }
                }
            },
        );

        return updateResult.matchedCount > 0;
    }

    /**
     * Stamps who published the deck and when. Written once — a second publish of
     * the same deck appends nothing and returns false, so the record shows the
     * first publication rather than the most recent overwrite.
     *
     * @return {Promise<boolean>}
     */
    static async recordPublication(deckId, publisherUserId)
    {
        const collection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.GENERATION_PROVENANCE_COLLECTION);

        const updateResult = await collection.updateOne(
            { deckId: deckId, publishedAt: null },
            { $set: { publishedByUserId: publisherUserId, publishedAt: Date.now() } },
        );

        return updateResult.modifiedCount > 0;
    }

    /**
     * Returns the provenance record for a deck, or null when there is none.
     * A null here is meaningful and must be surfaced rather than papered over:
     * it means the deck was not produced by the paid-deck generation pipeline,
     * so there is no record to show.
     */
    static async findByDeckId(deckId)
    {
        const collection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.GENERATION_PROVENANCE_COLLECTION);
        return await collection.findOne({ deckId: deckId }, { projection: { _id: 0 } });
    }
}

module.exports = GenerationProvenanceQueryEngine;
