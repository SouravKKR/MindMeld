const crypto = require("crypto");
const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");
const KeyManagementService = require("../../Globals/Classes/Security/KeyManagementService");
const PaidDeck = require("../../Globals/Model/PaidDeck");

async function uploadPaidDeck(request, response)
{
    if (!KeyManagementService.isReady())
    {
        response.statusCode = 503;
        response.sendJson({ error: "KEY_MANAGEMENT_NOT_READY" });
        return;
    }

    const body = await request.getBody();
    const metadata = body?.metadata;
    const deckPayload = body?.deckPayload;

    if (!metadata || !deckPayload)
    {
        response.statusCode = 400;
        response.sendJson({ error: "MISSING_METADATA_OR_PAYLOAD" });
        return;
    }

    const database = await DatabaseConnector.getDatabase();
    const paidDecksCollection = database.collection(DatabaseConstants.PAID_DECKS_COLLECTION);

    const incomingId = metadata.id || crypto.randomUUID();
    const existingDocument = await paidDecksCollection.findOne({ id: incomingId });
    const initialKeyVersion = existingDocument?.keyVersion || 1;
    const nextKeyVersion = existingDocument ? initialKeyVersion + 1 : 1;

    const encryptedPayload = KeyManagementService.encryptDeckPayload(deckPayload);

    await KeyManagementService.storeAsset
    (
        incomingId,
        { ...encryptedPayload, keyVersion: nextKeyVersion }
    );

    const paidDeckSeed =
    {
        id: incomingId,
        title: metadata.title,
        description: metadata.description || "",
        sellerId: metadata.sellerId || request.user?.getId() || "",
        thumbnailUrl: metadata.thumbnailUrl || "",
        category: metadata.category || "",
        tags: metadata.tags || [],
        basePriceMinor: metadata.basePriceMinor || 0,
        currency: metadata.currency || "INR",
        granularity: metadata.granularity || 0,
        bundleChildIds: metadata.bundleChildIds || [],
        parentBundleIds: metadata.parentBundleIds || [],
        assetBlobId: `${incomingId}:${nextKeyVersion}`,
        keyVersion: nextKeyVersion,
        isPublished: metadata.isPublished || false,
        publishedAt: metadata.publishedAt ? new Date(metadata.publishedAt).toISOString() : new Date().toISOString(),
        additionalData: metadata.additionalData || {}
    };

    const paidDeck = PaidDeck.fromJson(paidDeckSeed);
    const documentToWrite = paidDeck.toJson();
    documentToWrite.lastKeyRotationAt = new Date();

    await paidDecksCollection.updateOne
    (
        { id: incomingId },
        { $set: documentToWrite },
        { upsert: true }
    );

    response.statusCode = 200;
    response.sendJson({ success: true, deckId: incomingId, keyVersion: nextKeyVersion });
}

module.exports = { uploadPaidDeck };
