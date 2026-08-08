const GenerationProvenanceQueryEngine = require("../../../Globals/Classes/Database/GenerationProvenanceQueryEngine");
const PaidDeckPublishGate = require("../../../Globals/Classes/Generation/PaidDeckPublishGate");
const PaidDeckProvenanceLinkResolver = require("../../../Globals/Classes/Generation/PaidDeckProvenanceLinkResolver");
const ErrorCodes = require("../../../Globals/Constants/ErrorCodes");
const { httpStatus } = require("../../../Globals/Enumerations/HttpStatus");

/**
 * Records an administrator's decision about one verification flag.
 *
 * This is the ONLY way a blocking flag stops blocking. It appends a resolution
 * beside the flag — it never edits or removes the flag itself — so the stored
 * record continues to show both what verification found and what a named person
 * decided about it, with timestamps for each. That pairing is the difference
 * between a review gate and a dismiss button.
 *
 * The endpoint sits behind ensureAdmin, so AdminActionAuditor already records
 * the HTTP action; the resolution row records the content-specific decision that
 * the audit event cannot express.
 */
async function resolveVerificationFlag(request, response)
{
    const body = await request.getBody();
    const deckId = body?.deckId;
    const flagIndex = body?.flagIndex;
    const resolution = body?.resolution;

    if (!deckId || typeof flagIndex !== "number" || !resolution)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.MISSING_FIELDS });
        return;
    }

    // Only the two defined decisions clear a flag. Without this check an
    // arbitrary string ("looked at it") would be accepted and would silently
    // fail to clear anything — or worse, a future reader would take it as a
    // clearance it never was.
    if (!PaidDeckPublishGate.isClearingResolution(resolution))
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson
        ({
            error: ErrorCodes.INVALID_REQUEST,
            detail: `resolution must be one of "${PaidDeckPublishGate.RESOLUTION_FIXED}" or "${PaidDeckPublishGate.RESOLUTION_NOT_A_PROBLEM}".`,
        });
        return;
    }

    // Same bridge the review dialog reads through, so a resolution lands on the
    // record the gate will consult rather than on nothing at all.
    const provenanceDeckId = await PaidDeckProvenanceLinkResolver.resolveProvenanceDeckId(deckId);

    const provenanceRecords = await GenerationProvenanceQueryEngine.findAllByDeckId(provenanceDeckId);

    if (provenanceRecords.length === 0)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ error: ErrorCodes.PROVENANCE_NOT_FOUND });
        return;
    }

    // WHICH run's flag this is. A flag index is only meaningful inside the record
    // that raised it, so a deck generated into twice needs the run named or the
    // decision lands on whichever record happens to match first — clearing a flag
    // nobody reviewed. The client sends it; when it does not (an older client, or
    // a deck with a single run) it is resolved from the deck, and a deck with
    // several runs is refused rather than guessed at.
    const resolvedMainTaskId = resolveTargetRunId(provenanceRecords, body?.mainTaskId);

    if (resolvedMainTaskId === null)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson
        ({
            error: ErrorCodes.INVALID_REQUEST,
            detail: "This deck was produced by more than one generation run, so a resolution must name the run its flag belongs to.",
        });
        return;
    }

    const bRecorded = await GenerationProvenanceQueryEngine.recordFlagResolution(resolvedMainTaskId,
    {
        flagIndex: flagIndex,
        resolution: resolution,
        note: typeof body?.note === "string" ? body.note.substring(0, 2000) : null,
        actorUserId: request.user?.getId() || null,
    });

    if (!bRecorded)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ error: ErrorCodes.PROVENANCE_NOT_FOUND });
        return;
    }

    // Hand back the fresh decision so the panel can enable Publish the moment
    // the last blocking flag is resolved, without re-deriving the rule.
    const publishDecision = await PaidDeckPublishGate.evaluate(provenanceDeckId);

    response.statusCode = httpStatus.OK;
    response.sendJson({ success: true, publishDecision: publishDecision });
}

/**
 * Decides which generation run a resolution applies to.
 *
 * Returns the run id, or null when the deck holds several runs and the caller
 * named none of them — an ambiguity that must be refused rather than resolved by
 * picking one, because the wrong pick clears a flag that was never reviewed.
 *
 * A requested run id is checked against the deck's own records, so a crafted
 * request cannot append a decision to another deck's record.
 */
function resolveTargetRunId(provenanceRecords, requestedMainTaskId)
{
    if (typeof requestedMainTaskId === "string" && requestedMainTaskId.length > 0)
    {
        const bBelongsToThisDeck = provenanceRecords.some(provenanceRecord => provenanceRecord.mainTaskId === requestedMainTaskId);
        return bBelongsToThisDeck ? requestedMainTaskId : null;
    }

    if (provenanceRecords.length === 1)
    {
        return provenanceRecords[0].mainTaskId;
    }

    return null;
}

module.exports = { resolveVerificationFlag };
