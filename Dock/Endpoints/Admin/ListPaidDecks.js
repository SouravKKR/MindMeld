const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");

async function listPaidDecks(request, response)
{
    const queryParams = await request.getQueryParams();
    const includeUnpublished = queryParams.includeUnpublished === "true";

    const filter = includeUnpublished ? {} : { isPublished: true };

    const database = await DatabaseConnector.getDatabase();
    const documents = await database
        .collection(DatabaseConstants.PAID_DECKS_COLLECTION)
        .find(filter)
        .sort({ publishedAt: -1 })
        .limit(5000)
        .toArray();

    response.statusCode = 200;
    response.sendJson({ decks: documents.map(doc => { delete doc._id; return doc; }) });
}

module.exports = { listPaidDecks };
