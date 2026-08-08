const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const GenerationProvenanceQueryEngine = require("../Database/GenerationProvenanceQueryEngine");
const PaidDeckGenerationRunLocator = require("./PaidDeckGenerationRunLocator");

/**
 * PaidDeckProvenanceLinkResolver
 *
 * Turns a paid-deck listing id into the deck id its generation record is filed
 * under.
 *
 * The two are different ids and always were. A listing id is minted fresh by
 * the upload dialog; provenance is recorded against the deck the run produced,
 * because MoveToDatabase is the first place that knows which deck a run
 * produced. Every admin surface that reads provenance — the review dialog, the
 * flag resolution, the audit trail, the publish toggle — holds only the listing
 * id, so each of them needs this bridge. They previously queried the provenance
 * collection with the listing id directly, which by construction never matched:
 * the audit trail 404'd for every deck and the publish gate never blocked
 * anything.
 *
 * Carrying the link is necessary but was not sufficient. The link records the
 * deck the administrator PICKED, and that is routinely a different node of the
 * generated tree from the one the record is filed under — a run launched into
 * "Chemistry" files its record against the "Unit I: ..." deck it created, while
 * the tile the administrator picks to sell is "Chemistry". So a linked id with no
 * record of its own is not the end of the search: the deck is matched back to its
 * generation RUN (PaidDeckGenerationRunLocator) and that run's record is used.
 * Without this second step the audit trail still 404'd and the gate still waved
 * through decks whose verification had never been read — for exactly the decks
 * this pipeline produced.
 *
 * Kept separate from PaidDeckPublishGate on purpose. The gate's job is to decide
 * whether a provenance record permits publication; resolving which record
 * applies is a different question, and folding the lookup into the gate would
 * mean the gate silently allowed any deck whose row happened to be missing.
 */
class PaidDeckProvenanceLinkResolver
{
    /**
     * Resolves the provenance deck id for one listing.
     *
     * Falls back to the listing's own link (or the listing id) when no record can
     * be reached — the state of a deck this pipeline did not produce. That
     * reproduces the old behaviour for those decks (no record found, nothing to
     * verify) rather than refusing them, so deploying this does not retroactively
     * block decks that are already on sale.
     *
     * @param {string} paidDeckId
     * @returns {Promise<string>} the deck id to look provenance up by
     */
    static async resolveProvenanceDeckId(paidDeckId)
    {
        if (typeof paidDeckId !== "string" || paidDeckId.length === 0)
        {
            return "";
        }

        const database = await DatabaseConnector.getDatabase();
        const paidDeckDocument = await database
            .collection(DatabaseConstants.PAID_DECKS_COLLECTION)
            .findOne({ id: paidDeckId }, { projection: { _id: 0, provenanceDeckId: 1, sourceDeckId: 1 } });

        // Ordered by how directly each states which deck the sold content came
        // from. sourceDeckId is consulted because a listing published before the
        // provenance link existed still records where its content came from, and
        // the listing id itself is last — right only for a listing uploaded under
        // the generated deck's own id.
        const candidateDeckIds = PaidDeckProvenanceLinkResolver.#collectCandidateDeckIds(
            [paidDeckDocument?.provenanceDeckId, paidDeckDocument?.sourceDeckId, paidDeckId],
        );

        for (const candidateDeckId of candidateDeckIds)
        {
            const provenanceRecord = await PaidDeckProvenanceLinkResolver.#findRecordForDeckId(candidateDeckId);

            if (provenanceRecord !== null && typeof provenanceRecord.deckId === "string" && provenanceRecord.deckId.length > 0)
            {
                return provenanceRecord.deckId;
            }
        }

        const linkedDeckId = paidDeckDocument?.provenanceDeckId;

        return typeof linkedDeckId === "string" && linkedDeckId.length > 0 ? linkedDeckId : paidDeckId;
    }

    /**
     * Resolves a LIBRARY deck id — not a listing id — to the deck id whose
     * provenance record governs it.
     *
     * Returns the input unchanged when the deck already is the one the record
     * names, and when no run can be matched to it at all. The upload path calls
     * this so the link it stores points at the record from the start, rather than
     * leaving every later read to repeat the search.
     *
     * @param {string} deckId
     * @returns {Promise<string>}
     */
    static async resolveForDeckId(deckId)
    {
        if (typeof deckId !== "string" || deckId.length === 0)
        {
            return "";
        }

        const provenanceRecord = await PaidDeckProvenanceLinkResolver.#findRecordForDeckId(deckId);

        if (provenanceRecord === null || typeof provenanceRecord.deckId !== "string" || provenanceRecord.deckId.length === 0)
        {
            return deckId;
        }

        return provenanceRecord.deckId;
    }

    /**
     * The record governing one deck: the one filed against it, or failing that
     * the one belonging to the run that produced it.
     */
    static async #findRecordForDeckId(deckId)
    {
        const directRecord = await GenerationProvenanceQueryEngine.findByDeckId(deckId);
        if (directRecord !== null)
        {
            return directRecord;
        }

        const mainTaskId = await PaidDeckGenerationRunLocator.findMainTaskId(deckId);
        if (mainTaskId.length === 0)
        {
            return null;
        }

        const runRecord = await GenerationProvenanceQueryEngine.findByMainTaskId(mainTaskId);
        if (runRecord === null)
        {
            return null;
        }

        console.log(`[PaidDeckProvenanceLinkResolver] Deck ${deckId} resolved to provenance deck ${runRecord.deckId} via run ${mainTaskId}.`);

        return runRecord;
    }

    /**
     * Non-blank, de-duplicated, order preserved. The three candidates coincide
     * often enough — a listing uploaded from the generated deck itself makes all
     * three equal — that searching each one separately would triple the reads for
     * no additional coverage.
     */
    static #collectCandidateDeckIds(rawDeckIds)
    {
        const candidateDeckIds = [];

        for (const rawDeckId of rawDeckIds)
        {
            if (typeof rawDeckId === "string" && rawDeckId.length > 0 && !candidateDeckIds.includes(rawDeckId))
            {
                candidateDeckIds.push(rawDeckId);
            }
        }

        return candidateDeckIds;
    }
}

module.exports = PaidDeckProvenanceLinkResolver;
