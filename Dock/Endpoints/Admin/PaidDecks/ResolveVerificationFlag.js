const GenerationProvenanceQueryEngine = require("../../../Globals/Classes/Database/GenerationProvenanceQueryEngine");
const PaidDeckPublishGate = require("../../../Globals/Classes/Generation/PaidDeckPublishGate");
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

    const bRecorded = await GenerationProvenanceQueryEngine.recordFlagResolution(deckId,
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
    const publishDecision = await PaidDeckPublishGate.evaluate(deckId);

    response.statusCode = httpStatus.OK;
    response.sendJson({ success: true, publishDecision: publishDecision });
}

module.exports = { resolveVerificationFlag };
