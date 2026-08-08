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
 * One document per RUN, not per chunk. A per-chunk trail would be unreadable and
 * would grow without bound; the question this record answers is about an act of
 * generation ("what went into the thing you sold me"), so the run is the unit and
 * it is filed against the deck that run was launched into.
 *
 * A deck may therefore hold SEVERAL records — generation can be run into the same
 * deck more than once, and each run is separate evidence about a separate act.
 * None of them is a revision of another, so nothing here merges or supersedes:
 * findAllByDeckId returns them all, oldest first, and every reader is expected to
 * account for all of them. That is why the read method that returns a single
 * document is named findByMainTaskId — a run has one record, a deck does not.
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

            // The decks this run created beneath deckId. deckId is the deck the
            // run was launched into and the deck that gets sold; this is what the
            // run actually added to it, which is the part a reader needs when the
            // deck also holds content from another run or from the user's own
            // work.
            producedDeckIds: provenanceDetails.producedDeckIds || [],

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

        // Said out loud because it changes what every reader must do with this
        // deck: the gate has to clear all of them, and the audit trail has to
        // render all of them. Silence here is how "the deck was verified" quietly
        // comes to mean "one of the runs that made it was verified".
        const recordCountForDeck = await collection.countDocuments({ deckId: provenanceDocument.deckId });
        if (recordCountForDeck > 1)
        {
            console.log(
                `[GenerationProvenance] Deck ${provenanceDocument.deckId} now holds ${recordCountForDeck} generation records — `
                + "every one of them governs it.",
            );
        }

        return provenanceDocument;
    }

    /**
     * Appends a flag resolution. This is an APPEND to an array, never an edit of
     * the flag it refers to — the original flag stays exactly as verification
     * raised it, and the resolution sits beside it with its own actor and
     * timestamp. Reading the pair tells you both what was found and what was
     * decided, which is the point.
     *
     * Keyed on the RUN, not the deck. A flag index only means anything inside the
     * record that raised it, so a deck holding two runs would otherwise have had
     * a decision about run two's flag #0 appended to run one's record — clearing
     * a flag nobody looked at and leaving the real one blocking.
     *
     * @return {Promise<boolean>} True when a record existed to append to.
     */
    static async recordFlagResolution(mainTaskId, resolutionDetails)
    {
        if (typeof mainTaskId !== "string" || mainTaskId.length === 0)
        {
            return false;
        }

        const collection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.GENERATION_PROVENANCE_COLLECTION);

        const updateResult = await collection.updateOne(
            { mainTaskId: mainTaskId },
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
     * Appends the flags raised by a source-grounded verification pass to the
     * run's existing flag list.
     *
     * WHY THE SAME ARRAY, rather than a second one beside it. Everything
     * downstream addresses a flag by its INDEX into verification.flags — the
     * publish gate, ResolveVerificationFlag, the auto-fix proposal and apply,
     * the review dialog, the audit-trail PDF. Appending keeps every one of those
     * addresses valid, because an append never shifts an index that already
     * exists, so source-grounded flags block publication, get resolved and get
     * auto-fixed through the machinery that already exists rather than through a
     * parallel copy of it that would inevitably drift.
     *
     * IDEMPOTENT ON passId. The pass runs as a background task, and a task can
     * be started again — after a Dock restart lost the in-process marker, or
     * because an administrator pressed the button twice. Without this guard the
     * second run would append a second copy of every flag, and a duplicate
     * blocking flag has to be resolved twice to stop blocking, which reads as
     * the gate being broken. The passId is generated once per requested run and
     * carried through, so a re-run of the SAME pass is absorbed while a genuinely
     * new pass still appends.
     *
     * The counts are incremented rather than recomputed: the caller knows what it
     * is adding, and a recount would have to trust the array it is editing.
     *
     * @param {string} mainTaskId The run whose record receives the flags.
     * @param {string} passId Identity of the verification pass that raised them.
     * @param {object[]} flags
     * @return {Promise<{appended: boolean, reason: (string|null)}>}
     */
    static async appendSourceVerificationFlags(mainTaskId, passId, flags)
    {
        if (typeof mainTaskId !== "string" || mainTaskId.length === 0
            || typeof passId !== "string" || passId.length === 0)
        {
            return { appended: false, reason: "MISSING_IDENTIFIERS" };
        }

        if (!Array.isArray(flags) || flags.length === 0)
        {
            // A pass that found nothing still has to be recorded as having run,
            // or "no flags" is indistinguishable from "never checked". The pass
            // marker is written even with an empty flag list.
            return await GenerationProvenanceQueryEngine.#recordSourceVerificationPass(mainTaskId, passId, 0, 0);
        }

        const collection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.GENERATION_PROVENANCE_COLLECTION);

        const blockingCount = flags.filter(flag => flag.severity === "blocking").length;
        const advisoryCount = flags.length - blockingCount;

        // Matched on the pass NOT already being present. Mongo applies the
        // filter and the update atomically, so two concurrent completions of the
        // same pass cannot both pass the check and both append.
        const updateResult = await collection.updateOne(
            GenerationProvenanceQueryEngine.#buildAppendableFilter(mainTaskId, passId),
            {
                $push:
                {
                    "verification.flags": { $each: flags },
                    sourceVerificationPassIds: passId,
                },
                $inc:
                {
                    "verification.blockingFlagCount": blockingCount,
                    "verification.advisoryFlagCount": advisoryCount,
                },
            },
        );

        if (updateResult.matchedCount === 0)
        {
            return await GenerationProvenanceQueryEngine.#explainAppendRefusal(mainTaskId, passId);
        }

        return { appended: true, reason: null };
    }

    /**
     * The filter every source-flag append runs through.
     *
     * The verification.flags type check is the load-bearing part. A run that was
     * never verified has no verification object at all, and a $push into
     * "verification.flags" would CREATE one — leaving a record that carries an
     * array of flags and therefore reads, to PaidDeckPublishGate, as a run that
     * was verified. That is the precise failure the gate exists to prevent: it
     * refuses a run with no verification result, and this would have handed it a
     * fabricated one. A source-grounded pass adds to a verification; it is not
     * one.
     */
    static #buildAppendableFilter(mainTaskId, passId)
    {
        return {
            mainTaskId: mainTaskId,
            sourceVerificationPassIds: { $ne: passId },
            "verification.flags": { $type: "array" },
        };
    }

    /**
     * Says WHY an append matched nothing, so the caller can log something a
     * reader can act on instead of a bare false.
     */
    static async #explainAppendRefusal(mainTaskId, passId)
    {
        const provenanceRecord = await GenerationProvenanceQueryEngine.findByMainTaskId(mainTaskId);

        if (provenanceRecord === null)
        {
            return { appended: false, reason: "RECORD_NOT_FOUND" };
        }

        if (!provenanceRecord.verification || !Array.isArray(provenanceRecord.verification.flags))
        {
            return { appended: false, reason: "RUN_NOT_VERIFIED" };
        }

        const appliedPassIds = Array.isArray(provenanceRecord.sourceVerificationPassIds)
            ? provenanceRecord.sourceVerificationPassIds
            : [];

        return {
            appended: false,
            reason: appliedPassIds.includes(passId) ? "PASS_ALREADY_APPENDED" : "NOT_APPENDED",
        };
    }

    /**
     * Records that a source-grounded pass ran and raised nothing.
     *
     * Separate from the append above only because $push with an empty $each is a
     * no-op that would still consume the passId, making a later real append for
     * the same pass impossible to distinguish from a duplicate.
     */
    static async #recordSourceVerificationPass(mainTaskId, passId, blockingCount, advisoryCount)
    {
        const collection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.GENERATION_PROVENANCE_COLLECTION);

        const updateResult = await collection.updateOne(
            GenerationProvenanceQueryEngine.#buildAppendableFilter(mainTaskId, passId),
            {
                $push: { sourceVerificationPassIds: passId },
                $inc:
                {
                    "verification.blockingFlagCount": blockingCount,
                    "verification.advisoryFlagCount": advisoryCount,
                },
            },
        );

        if (updateResult.matchedCount === 0)
        {
            return await GenerationProvenanceQueryEngine.#explainAppendRefusal(mainTaskId, passId);
        }

        return { appended: true, reason: null };
    }

    /**
     * Stamps who published the deck and when, on EVERY unpublished record the
     * deck has — each run that contributed content is part of what was published,
     * so each one's record should say when that happened. Written once per record:
     * a later re-publish appends nothing, so they show the first publication
     * rather than the most recent overwrite.
     *
     * @return {Promise<number>} How many records were stamped.
     */
    static async recordPublication(deckId, publisherUserId)
    {
        const collection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.GENERATION_PROVENANCE_COLLECTION);

        const updateResult = await collection.updateMany(
            { deckId: deckId, publishedAt: null },
            { $set: { publishedByUserId: publisherUserId, publishedAt: Date.now() } },
        );

        return updateResult.modifiedCount;
    }

    /**
     * Returns ONE of the deck's provenance records — the earliest — or null when
     * there is none. A null here is meaningful and must be surfaced rather than
     * papered over: it means the deck was not produced by the paid-deck
     * generation pipeline, so there is no record to show.
     *
     * Only for callers that genuinely want a single record (does one exist? what
     * is this deck's first run?). Anything deciding whether a deck may be
     * published, or reporting what went into it, must use findAllByDeckId —
     * a deck generated into twice has two records and reading only the first
     * would report on half the content.
     */
    static async findByDeckId(deckId)
    {
        const collection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.GENERATION_PROVENANCE_COLLECTION);
        return await collection.findOne({ deckId: deckId }, { projection: { _id: 0 }, sort: { recordedAt: 1 } });
    }

    /**
     * Every provenance record filed against a deck, oldest first.
     *
     * Chronological because that is the order the content was made in, and the
     * order a reader has to follow to understand what the deck became.
     */
    static async findAllByDeckId(deckId)
    {
        if (typeof deckId !== "string" || deckId.length === 0)
        {
            return [];
        }

        const collection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.GENERATION_PROVENANCE_COLLECTION);
        return await collection.find({ deckId: deckId }, { projection: { _id: 0 } }).sort({ recordedAt: 1 }).toArray();
    }

    /**
     * Returns the provenance record for a generation RUN rather than for one
     * deck, or null when there is none.
     *
     * A run produces a tree of decks and files its record against the top-level
     * one, so "which deck is this?" and "which run made this?" are different
     * questions with different answers. Anything holding a deck rather than the
     * exact deck the record names — a listing for a parent deck, a sub-deck sold
     * on its own — reaches the record through here, via
     * PaidDeckGenerationRunLocator.
     */
    static async findByMainTaskId(mainTaskId)
    {
        if (typeof mainTaskId !== "string" || mainTaskId.length === 0)
        {
            return null;
        }

        const collection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.GENERATION_PROVENANCE_COLLECTION);
        return await collection.findOne({ mainTaskId: mainTaskId }, { projection: { _id: 0 } });
    }
}

module.exports = GenerationProvenanceQueryEngine;
