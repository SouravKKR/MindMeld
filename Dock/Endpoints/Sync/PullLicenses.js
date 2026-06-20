const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");
const LicenseClientView = require("../../Globals/Classes/Security/LicenseClientView");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");

async function pullLicenses(request, response)
{
    const session = request.session;

    if (!session)
    {
        response.sendStatusCode(httpStatus.UNAUTHORIZED);
        return;
    }

    const body = await request.getBody();
    const sinceTimestampMilliseconds = body?.sinceTimestamp || 0;
    // The codegen-generated DeckLicense.toJson serialises dates as ISO strings,
    // so rotatedAt is stored in Mongo as a string, not a BSON Date. Comparing a
    // stored string against `$gt: new Date()` is a cross-type comparison that
    // Mongo never matches (string < Date in the type-bracket order), which made
    // this endpoint silently return zero licenses — leaving PaidDeckRegistry
    // empty and the Buy button showing for already-owned decks. ISO-8601 strings
    // sort lexicographically the same as chronologically, so doing the comparison
    // string-to-string fixes it. (Same fix as PaidDeckPricingEngine.#getOwnedDeckIds.)
    const sinceIsoString = new Date(sinceTimestampMilliseconds).toISOString();

    const database = await DatabaseConnector.getDatabase();
    const licenseDocuments = await database
        .collection(DatabaseConstants.DECK_LICENSES_COLLECTION)
        .find
        ({
            userId: session.getUserId(),
            rotatedAt: { $gt: sinceIsoString }
        })
        .toArray();

    // Strip the secret key material (password/server-wrapped content keys,
    // salt, hash) before the licenses reach the browser — the client persists
    // these and never needs them; the wrapped key is re-fetched over ECDH at
    // unlock time. See LicenseClientView.
    response.statusCode = httpStatus.OK;
    response.sendJson
    ({
        licenses: LicenseClientView.sanitizeMany(licenseDocuments),
        serverTimestamp: Date.now()
    });
}

module.exports = { pullLicenses };
