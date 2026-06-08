const crypto = require("crypto");
const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");
const KeyManagementService = require("../../Globals/Classes/Security/KeyManagementService");
const PaidDeck = require("../../Globals/Model/PaidDeck");
const PaidDeckPricing = require("../../Globals/Model/PaidDeckPricing");
const PaidDeckContentSummarizer = require("../../Globals/Classes/PaidDeck/PaidDeckContentSummarizer");
const RegionMetadata = require("../../Globals/Classes/Pricing/RegionMetadata");

/**
 * Upserts the admin-supplied per-region price overrides into the
 * paidDeckPricings collection that PaidDeckPricingEngine reads. The base
 * price (deck.basePriceMinor/currency) remains the canonical default; these
 * rows only override specific regions. Keyed by (deckId, region) so a
 * re-upload replaces a region's price instead of stacking duplicate rows,
 * and regions the admin didn't include are left untouched.
 */
async function upsertRegionalPriceOverrides(database, deckId, regionalPrices)
{
    if (!Array.isArray(regionalPrices) || regionalPrices.length === 0)
    {
        return;
    }

    const collection = database.collection(DatabaseConstants.PAID_DECK_PRICINGS_COLLECTION);
    const farFutureIso = new Date(8640000000000000).toISOString();

    for (const entry of regionalPrices)
    {
        const region = typeof entry?.region === "string" ? entry.region.toUpperCase() : "";
        if (!RegionMetadata.isValidRegion(region))
        {
            continue;
        }

        const pricing = PaidDeckPricing.fromJson
        ({
            deckId: deckId,
            region: region,
            priceMinor: entry.priceMinor || 0,
            currency: (entry.currency || RegionMetadata.getDisplayCurrency(region)).toUpperCase(),
            discountPercent: 0,
            effectiveFrom: new Date().toISOString(),
            effectiveUntil: farFutureIso,
            additionalData: {}
        });

        await collection.updateOne
        (
            { deckId: deckId, region: region },
            { $set: pricing.toJson() },
            { upsert: true }
        );
    }
}

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

    // Storefront metadata that lives only on the paidDecks document —
    // never enters the encrypted asset, never reaches buyers' local
    // storage when they download the deck.
    if (Array.isArray(metadata.featureBadges))
    {
        documentToWrite.featureBadges = metadata.featureBadges;
    }
    else if (existingDocument && Array.isArray(existingDocument.featureBadges))
    {
        documentToWrite.featureBadges = existingDocument.featureBadges;
    }
    else
    {
        documentToWrite.featureBadges = [];
    }

    if (Array.isArray(metadata.extraTags))
    {
        documentToWrite.extraTags = metadata.extraTags;
    }
    else if (existingDocument && Array.isArray(existingDocument.extraTags))
    {
        documentToWrite.extraTags = existingDocument.extraTags;
    }
    else
    {
        documentToWrite.extraTags = [];
    }

    // Content summary is recomputed from the just-uploaded payload.
    // contentVersion bumps every time content changes so existing
    // buyers can detect available updates without conflating with
    // periodic key rotations.
    const previousContentVersion = existingDocument?.contentSummary?.contentVersion || 0;
    const computedSummary = PaidDeckContentSummarizer.summarize(deckPayload);
    documentToWrite.contentSummary =
    {
        ...computedSummary,
        contentVersion: previousContentVersion + 1
    };

    await paidDecksCollection.updateOne
    (
        { id: incomingId },
        { $set: documentToWrite },
        { upsert: true }
    );

    // Persist optional per-region price overrides (the upload dialog's
    // "Regional prices" rows) into the pricing collection the engine reads.
    await upsertRegionalPriceOverrides(database, incomingId, metadata.regionalPrices);

    response.statusCode = 200;
    response.sendJson
    ({
        success: true,
        deckId: incomingId,
        keyVersion: nextKeyVersion,
        contentVersion: documentToWrite.contentSummary.contentVersion
    });
}

module.exports = { uploadPaidDeck };
