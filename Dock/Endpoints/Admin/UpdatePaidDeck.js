const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");

const ALLOWED_FIELDS = new Set
([
    "title",
    "description",
    "thumbnailUrl",
    "category",
    "tags",
    "basePriceMinor",
    "currency",
    "durationDays",
    "isPerpetual",
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
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.MISSING_ID_OR_UPDATES });
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

    // Coerce the license-duration controls to their canonical primitive types so
    // a malformed payload can never persist a non-integer window or a truthy
    // object as the perpetual flag.
    if (Object.prototype.hasOwnProperty.call(setOperations, "durationDays"))
    {
        const durationDaysValue = Number(setOperations.durationDays);
        setOperations.durationDays = Number.isFinite(durationDaysValue) && durationDaysValue > 0 ? Math.floor(durationDaysValue) : 0;
    }
    if (Object.prototype.hasOwnProperty.call(setOperations, "isPerpetual"))
    {
        setOperations.isPerpetual = setOperations.isPerpetual === true;
    }

    if (Object.keys(setOperations).length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.NO_VALID_FIELDS });
        return;
    }

    // Stamp the "date modified" the details page shows on every real edit.
    setOperations.updatedAt = new Date();

    const database = await DatabaseConnector.getDatabase();
    const result = await database
        .collection(DatabaseConstants.PAID_DECKS_COLLECTION)
        .updateOne({ id: deckId }, { $set: setOperations });

    response.statusCode = httpStatus.OK;
    response.sendJson({ success: true, matchedCount: result.matchedCount, modifiedCount: result.modifiedCount });
}

module.exports = { updatePaidDeck };
