const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");

async function pullLicenses(request, response)
{
    const session = request.session;

    if (!session)
    {
        response.sendStatusCode(401);
        return;
    }

    const body = await request.getBody();
    const sinceTimestampMilliseconds = body?.sinceTimestamp || 0;
    const sinceDate = new Date(sinceTimestampMilliseconds);

    const database = await DatabaseConnector.getDatabase();
    const licenseDocuments = await database
        .collection(DatabaseConstants.DECK_LICENSES_COLLECTION)
        .find
        ({
            userId: session.getUserId(),
            rotatedAt: { $gt: sinceDate }
        })
        .toArray();

    const cleaned = licenseDocuments.map(document =>
    {
        delete document._id;
        return document;
    });

    response.statusCode = 200;
    response.sendJson
    ({
        licenses: cleaned,
        serverTimestamp: Date.now()
    });
}

module.exports = { pullLicenses };
