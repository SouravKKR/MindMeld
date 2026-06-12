const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");
const LicenseClientView = require("../../Globals/Classes/Security/LicenseClientView");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");

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

    // Licenses carry secret key material (wrapped content keys, salt, hash) that
    // the client must never receive or persist — strip it via LicenseClientView.
    response.statusCode = httpStatus.OK;
    response.sendJson
    ({
        purchases: purchases.map(purchase => { delete purchase._id; return purchase; }),
        licenses: LicenseClientView.sanitizeMany(licenses)
    });
}

module.exports = { getMyPurchases };
