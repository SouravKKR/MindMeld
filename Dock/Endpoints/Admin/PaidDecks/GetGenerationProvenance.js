const GenerationProvenanceQueryEngine = require("../../../Globals/Classes/Database/GenerationProvenanceQueryEngine");
const PaidDeckPublishGate = require("../../../Globals/Classes/Generation/PaidDeckPublishGate");
const PaidDeckProvenanceLinkResolver = require("../../../Globals/Classes/Generation/PaidDeckProvenanceLinkResolver");
const ErrorCodes = require("../../../Globals/Constants/ErrorCodes");
const { httpStatus } = require("../../../Globals/Enumerations/HttpStatus");

/**
 * Returns the generation-provenance record for one deck, together with the
 * current publish decision.
 *
 * This is what the admin panel's review gate reads: it shows the verification
 * flags, which of them are still blocking, and therefore why the Publish button
 * is refusing. Returning the decision alongside the record means the panel does
 * not re-implement the gate's logic and cannot drift from it — the server that
 * refuses the publish is the same server that explains the refusal.
 */
async function getGenerationProvenance(request, response)
{
    const queryParams = await request.getQueryParams();
    const deckId = queryParams.deckId;

    if (!deckId)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.MISSING_DECK_ID });
        return;
    }

    // The panel holds a listing id; provenance is filed under the source deck
    // the listing was published from. Bridging here keeps the request shape
    // unchanged for the caller.
    const provenanceDeckId = await PaidDeckProvenanceLinkResolver.resolveProvenanceDeckId(deckId);

    // Every run that put content into this deck, oldest first. A deck generated
    // into more than once has one record per run and the reviewer has to be able
    // to answer all of them — the gate below refuses until they have.
    const provenanceRecords = await GenerationProvenanceQueryEngine.findAllByDeckId(provenanceDeckId);

    if (provenanceRecords.length === 0)
    {
        // A meaningful answer, not an error to paper over: this deck was not
        // produced by the paid-deck generation pipeline, so there is no record.
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ error: ErrorCodes.PROVENANCE_NOT_FOUND });
        return;
    }

    const publishDecision = await PaidDeckPublishGate.evaluate(provenanceDeckId);

    response.statusCode = httpStatus.OK;
    response.sendJson
    ({
        // `provenance` is the first run, kept so an older client that reads a
        // single record still shows something true rather than nothing.
        provenance: provenanceRecords[0],
        provenanceRecords: provenanceRecords,
        publishDecision: publishDecision,
    });
}

module.exports = { getGenerationProvenance };
