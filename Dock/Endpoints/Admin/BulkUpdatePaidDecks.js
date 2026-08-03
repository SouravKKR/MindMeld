const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");
const PaidDeckPublishGate = require("../../Globals/Classes/Generation/PaidDeckPublishGate");

/**
 * BulkUpdatePaidDecks
 *
 * Applies a partial field set to many decks in a single round-trip.
 * Used by the admin panel's "apply to all subdecks" and "apply to
 * selected decks" flows. Per-field policies:
 *
 *   - assign:  $set the field to the supplied value (replaces).
 *   - merge:   $set into an object's sub-keys (additionalData merge).
 *   - addTags: $addToSet onto an array field (union, no duplicates).
 *
 * Ungated fields like `assetBlobId`, `keyVersion`, and `id` are not
 * accepted here — they're only mutated by the upload + key-rotation
 * paths which own that data.
 */
const ASSIGNABLE_FIELDS = new Set
([
    "title",
    "description",
    "sellerId",
    "thumbnailUrl",
    "category",
    "currency",
    "granularity",
    "basePriceMinor",
    "isPublished"
]);

const ARRAY_ADDABLE_FIELDS = new Set(["tags", "parentBundleIds", "bundleChildIds"]);

async function bulkUpdatePaidDecks(request, response)
{
    const body = await request.getBody();
    const deckIds = Array.isArray(body?.deckIds) ? body.deckIds : null;
    const assignments = body?.assignments && typeof body.assignments === "object" ? body.assignments : null;
    const tagAdditions = Array.isArray(body?.addTags) ? body.addTags : null;
    const additionalDataMerge = body?.additionalDataMerge && typeof body.additionalDataMerge === "object" ? body.additionalDataMerge : null;

    if (!deckIds || deckIds.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.MISSING_DECK_IDS });
        return;
    }

    const setOperations = {};
    const addToSetOperations = {};

    if (assignments)
    {
        for (const fieldKey of Object.keys(assignments))
        {
            if (ASSIGNABLE_FIELDS.has(fieldKey))
            {
                setOperations[fieldKey] = assignments[fieldKey];
            }
            else if (ARRAY_ADDABLE_FIELDS.has(fieldKey) && Array.isArray(assignments[fieldKey]))
            {
                // Full replace of an array field — admin opted in by
                // putting it under "assignments" instead of "addTags".
                setOperations[fieldKey] = assignments[fieldKey];
            }
        }
    }

    // ── Phase 8 review gate ───────────────────────────────────────────────
    // A bulk publish is still a publish. Every named deck is evaluated and the
    // whole operation is refused if ANY of them is blocked, rather than
    // publishing the rest — a partial bulk publish would leave the admin
    // believing they published a set they did not, which is how a blocked deck
    // quietly reaches buyers.
    if (setOperations.isPublished === true)
    {
        const blockedDeckDecisions = [];

        for (const candidateDeckId of deckIds)
        {
            const publishDecision = await PaidDeckPublishGate.evaluate(candidateDeckId);
            if (!publishDecision.allowed)
            {
                blockedDeckDecisions.push({ deckId: candidateDeckId, detail: publishDecision.detail, blockingFlags: publishDecision.blockingFlags });
            }
        }

        if (blockedDeckDecisions.length > 0)
        {
            response.statusCode = httpStatus.CONFLICT;
            response.sendJson
            ({
                error: ErrorCodes.PUBLISH_BLOCKED_BY_VERIFICATION_FLAGS,
                detail: `${blockedDeckDecisions.length} of ${deckIds.length} deck(s) have unresolved blocking verification flags. No deck was published.`,
                blockedDecks: blockedDeckDecisions,
            });
            return;
        }
    }

    if (additionalDataMerge)
    {
        for (const subKey of Object.keys(additionalDataMerge))
        {
            setOperations[`additionalData.${subKey}`] = additionalDataMerge[subKey];
        }
    }

    if (tagAdditions && tagAdditions.length > 0)
    {
        addToSetOperations.tags = { $each: tagAdditions };
    }

    const updateDocument = {};

    if (Object.keys(setOperations).length > 0)
    {
        updateDocument.$set = setOperations;
    }

    if (Object.keys(addToSetOperations).length > 0)
    {
        updateDocument.$addToSet = addToSetOperations;
    }

    if (Object.keys(updateDocument).length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.NO_VALID_FIELDS_TO_APPLY });
        return;
    }

    const database = await DatabaseConnector.getDatabase();
    const updateResult = await database
        .collection(DatabaseConstants.PAID_DECKS_COLLECTION)
        .updateMany({ id: { $in: deckIds } }, updateDocument);

    response.statusCode = httpStatus.OK;
    response.sendJson
    ({
        success: true,
        matchedCount: updateResult.matchedCount,
        modifiedCount: updateResult.modifiedCount
    });
}

module.exports = { bulkUpdatePaidDecks };
