const GenerationProvenanceQueryEngine = require("../../../Globals/Classes/Database/GenerationProvenanceQueryEngine");
const PaidDeckPublishGate = require("../../../Globals/Classes/Generation/PaidDeckPublishGate");
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

    const provenanceRecord = await GenerationProvenanceQueryEngine.findByDeckId(deckId);

    if (provenanceRecord === null)
    {
        // A meaningful answer, not an error to paper over: this deck was not
        // produced by the paid-deck generation pipeline, so there is no record.
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ error: ErrorCodes.PROVENANCE_NOT_FOUND });
        return;
    }

    const publishDecision = await PaidDeckPublishGate.evaluate(deckId);

    response.statusCode = httpStatus.OK;
    response.sendJson({ provenance: provenanceRecord, publishDecision: publishDecision });
}

module.exports = { getGenerationProvenance };
