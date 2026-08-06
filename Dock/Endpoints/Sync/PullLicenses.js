const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");
const LicenseClientView = require("../../Globals/Classes/Security/LicenseClientView");
const LicenseContentVersionResolver = require("../../Globals/Classes/PaidDeck/LicenseContentVersionResolver");
const OrganizationScopeResolver = require("../../Globals/Classes/Organization/OrganizationScopeResolver");
const PaidDeckScopeResolver = require("../../Globals/Classes/PaidDeck/PaidDeckScopeResolver");
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

    // Licenses are keyed by the PERSON, but their seeded content belongs to one
    // library. A device in an organization view must not receive the licenses of
    // marketplace decks that live in the personal library — the tiles would
    // appear with no content behind them, and the marketplace is deliberately a
    // personal-view surface. Selecting by scope keeps each view's registry
    // matching the decks that view actually holds. "" is the legacy value every
    // license issued before scoping carries, and means personal.
    const scope = await OrganizationScopeResolver.resolve(request, session.getUserId());
    const visibleScopeCondition = PaidDeckScopeResolver.buildVisibleScopeCondition(scope.scopeKey, session.getUserId());

    const licenseDocuments = await database
        .collection(DatabaseConstants.DECK_LICENSES_COLLECTION)
        .find
        ({
            userId: session.getUserId(),
            scopeKey: visibleScopeCondition,
            rotatedAt: { $gt: sinceIsoString }
        })
        .toArray();

    // Attach the content version each deck currently publishes, so the client
    // can tell which copies are behind. keyVersion cannot answer that — it
    // tracks the master asset key and moves on key rotation rather than on a
    // content upload.
    const availableContentVersionByDeckId = await resolveAvailableContentVersions(database, licenseDocuments);

    // Legacy backfill. Every license issued before content versioning has
    // downloadedContentVersion 0 while every deck has contentVersion >= 1, so a
    // naive comparison would tell EVERY existing buyer an update is waiting for
    // content they already have — and accepting it would reset their progress
    // for nothing. Treat 0 as "unknown, assume current" and record the current
    // version now, so the comparison becomes meaningful from here on. Idempotent,
    // needs no migration script, and self-heals as buyers sync.
    await backfillUnknownContentVersions(database, session.getUserId(), licenseDocuments, availableContentVersionByDeckId);

    // Strip the secret key material (password/server-wrapped content keys,
    // salt, hash) before the licenses reach the browser — the client persists
    // these and never needs them; the wrapped key is re-fetched over ECDH at
    // unlock time. See LicenseClientView.
    const sanitizedLicenses = LicenseClientView.sanitizeMany(licenseDocuments).map((sanitizedLicense) =>
    ({
        ...sanitizedLicense,
        availableContentVersion: availableContentVersionByDeckId.get(sanitizedLicense.deckId) || 0
    }));

    response.statusCode = httpStatus.OK;
    response.sendJson
    ({
        licenses: sanitizedLicenses,
        serverTimestamp: Date.now()
    });
}

/**
 * The current published content version of every deck the returned licenses
 * refer to, in one query.
 */
async function resolveAvailableContentVersions(database, licenseDocuments)
{
    const availableContentVersionByDeckId = new Map();
    const deckIds = licenseDocuments.map(licenseDocument => licenseDocument.deckId).filter(deckId => typeof deckId === "string" && deckId.length > 0);

    if (deckIds.length === 0)
    {
        return availableContentVersionByDeckId;
    }

    const paidDeckDocuments = await database
        .collection(DatabaseConstants.PAID_DECKS_COLLECTION)
        .find({ id: { $in: deckIds } }, { projection: { _id: 0, id: 1, contentSummary: 1 } })
        .toArray();

    for (const paidDeckDocument of paidDeckDocuments)
    {
        const contentVersion = Number(paidDeckDocument?.contentSummary?.contentVersion);
        availableContentVersionByDeckId.set(paidDeckDocument.id, Number.isInteger(contentVersion) && contentVersion > 0 ? contentVersion : 1);
    }

    return availableContentVersionByDeckId;
}

/**
 * Stamps the deck's current content version onto any license whose seeded
 * version is unknown, and mirrors it onto the in-memory documents so this same
 * response already reflects it.
 */
async function backfillUnknownContentVersions(database, userId, licenseDocuments, availableContentVersionByDeckId)
{
    const backfillOperations = [];

    for (const licenseDocument of licenseDocuments)
    {
        const availableContentVersion = availableContentVersionByDeckId.get(licenseDocument.deckId) || 0;
        if (availableContentVersion === 0)
        {
            continue;
        }

        const instances = Array.isArray(licenseDocument.additionalData?.instances) ? licenseDocument.additionalData.instances : [];
        let bChanged = false;

        for (const instance of instances)
        {
            if (instance && !LicenseContentVersionResolver.normalizeVersion(instance.contentVersion))
            {
                instance.contentVersion = availableContentVersion;
                bChanged = true;
            }
        }

        if (!LicenseContentVersionResolver.normalizeVersion(licenseDocument.downloadedContentVersion))
        {
            licenseDocument.downloadedContentVersion = availableContentVersion;
            bChanged = true;
        }

        if (bChanged)
        {
            backfillOperations.push
            ({
                updateOne:
                {
                    filter: { userId: userId, deckId: licenseDocument.deckId },
                    update: { $set: { downloadedContentVersion: licenseDocument.downloadedContentVersion, "additionalData.instances": instances } }
                }
            });
        }
    }

    if (backfillOperations.length === 0)
    {
        return;
    }

    try
    {
        await database.collection(DatabaseConstants.DECK_LICENSES_COLLECTION).bulkWrite(backfillOperations, { ordered: false });
    }
    catch (backfillError)
    {
        // Best-effort: a failed backfill only means the next pull tries again.
        console.warn(`[PullLicenses] Content-version backfill failed for user ${userId}:`, backfillError.message);
    }
}

module.exports = { pullLicenses };
