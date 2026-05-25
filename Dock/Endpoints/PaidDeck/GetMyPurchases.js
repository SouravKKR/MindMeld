const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");

async function getMyPurchases(request, response)
{
    const session = request.session;

    if (!session)
    {
        response.sendStatusCode(401);
        return;
    }

    const database = await DatabaseConnector.getDatabase();
    const purchases = await database
        .collection(DatabaseConstants.PURCHASES_COLLECTION)
        .find({ userId: session.getUserId() })
        .sort({ purchaseDate: -1 })
        .limit(2000)
        .toArray();

    const licenses = await database
        .collection(DatabaseConstants.DECK_LICENSES_COLLECTION)
        .find({ userId: session.getUserId() })
        .limit(2000)
        .toArray();

    response.statusCode = 200;
    response.sendJson
    ({
        purchases: purchases.map(purchase => { delete purchase._id; return purchase; }),
        licenses: licenses.map(license => { delete license._id; return license; })
    });
}

module.exports = { getMyPurchases };
