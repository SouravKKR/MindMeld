const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");

const ALLOWED_FIELDS = new Set
([
    "title",
    "description",
    "thumbnailUrl",
    "category",
    "tags",
    "basePriceMinor",
    "currency",
    "granularity",
    "bundleChildIds",
    "parentBundleIds",
    "isPublished",
    "additionalData",
    "featureBadges",
    "extraTags"
]);

async function updatePaidDeck(request, response)
{
    const body = await request.getBody();
    const deckId = body?.id;
    const updates = body?.updates;

    if (!deckId || !updates)
    {
        response.statusCode = 400;
        response.sendJson({ error: "MISSING_ID_OR_UPDATES" });
        return;
    }

    const setOperations = {};

    for (const fieldKey of Object.keys(updates))
    {
        if (ALLOWED_FIELDS.has(fieldKey))
        {
            setOperations[fieldKey] = updates[fieldKey];
        }
    }

    if (Object.keys(setOperations).length === 0)
    {
        response.statusCode = 400;
        response.sendJson({ error: "NO_VALID_FIELDS" });
        return;
    }

    const database = await DatabaseConnector.getDatabase();
    const result = await database
        .collection(DatabaseConstants.PAID_DECKS_COLLECTION)
        .updateOne({ id: deckId }, { $set: setOperations });

    response.statusCode = 200;
    response.sendJson({ success: true, matchedCount: result.matchedCount, modifiedCount: result.modifiedCount });
}

module.exports = { updatePaidDeck };
