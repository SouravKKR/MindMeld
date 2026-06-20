const crypto = require("crypto");
const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");

async function setPaidDeckBundle(request, response)
{
    const body = await request.getBody();
    const bundleDeckId = body?.bundleDeckId;
    const includedDecks = Array.isArray(body?.includedDecks) ? body.includedDecks : null;

    if (!bundleDeckId || !includedDecks)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.MISSING_BUNDLE_DECK_ID_OR_INCLUDED_DECKS });
        return;
    }

    const database = await DatabaseConnector.getDatabase();
    const bundleCollection = database.collection(DatabaseConstants.BUNDLE_DISCOUNTS_COLLECTION);
    const paidDecksCollection = database.collection(DatabaseConstants.PAID_DECKS_COLLECTION);

    await bundleCollection.deleteMany({ bundleDeckId: bundleDeckId });

    const childIds = [];

    for (const included of includedDecks)
    {
        if (!included?.includedDeckId)
        {
            continue;
        }

        childIds.push(included.includedDeckId);

        await bundleCollection.insertOne
        ({
            id: crypto.randomUUID(),
            bundleDeckId: bundleDeckId,
            includedDeckId: included.includedDeckId,
            discountPercentWhenIncluded: included.discountPercentWhenIncluded ?? 100
        });

        await paidDecksCollection.updateOne
        (
            { id: included.includedDeckId },
            { $addToSet: { parentBundleIds: bundleDeckId } }
        );
    }

    await paidDecksCollection.updateOne
    (
        { id: bundleDeckId },
        { $set: { bundleChildIds: childIds } }
    );

    response.statusCode = httpStatus.OK;
    response.sendJson({ success: true, childCount: childIds.length });
}

module.exports = { setPaidDeckBundle };
