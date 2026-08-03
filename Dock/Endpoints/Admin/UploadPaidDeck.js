const crypto = require("crypto");
const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");
const KeyManagementService = require("../../Globals/Classes/Security/KeyManagementService");
const PaidDeckEntityTooLargeError = require("../../Globals/Classes/Security/PaidDeckEntityTooLargeError");
const PaidDeck = require("../../Globals/Model/PaidDeck");
const PaidDeckPricing = require("../../Globals/Model/PaidDeckPricing");
const PaidDeckContentSummarizer = require("../../Globals/Classes/PaidDeck/PaidDeckContentSummarizer");
const RegionMetadata = require("../../Globals/Classes/Pricing/RegionMetadata");
const BrandNameSanitizer = require("../../Globals/Classes/Content/BrandNameSanitizer");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");
const PaidDeckPublishGate = require("../../Globals/Classes/Generation/PaidDeckPublishGate");
const GenerationProvenanceQueryEngine = require("../../Globals/Classes/Database/GenerationProvenanceQueryEngine");

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
            // License duration is explicit per region: a positive durationDays
            // sells a finite rental; isPerpetual sells lifetime access. A region
            // that overrides neither inherits the deck-level default below only
            // if it also leaves both blank there — otherwise the buyer's grant is
            // refused (see LicenseExpiryResolver).
            durationDays: Number.isInteger(entry.durationDays) && entry.durationDays > 0 ? entry.durationDays : 0,
            isPerpetual: entry.isPerpetual === true,
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
        response.statusCode = httpStatus.SERVICE_UNAVAILABLE;
        response.sendJson({ error: ErrorCodes.KEY_MANAGEMENT_NOT_READY });
        return;
    }

    const body = await request.getBody();
    const metadata = body?.metadata;
    const deckPayload = body?.deckPayload;

    if (!metadata || !deckPayload)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.MISSING_METADATA_OR_PAYLOAD });
        return;
    }

    const database = await DatabaseConnector.getDatabase();
    const paidDecksCollection = database.collection(DatabaseConstants.PAID_DECKS_COLLECTION);

    const incomingId = metadata.id || crypto.randomUUID();

    // ── Phase 8 review gate ───────────────────────────────────────────────────
    // Publishing a pipeline-generated deck with unresolved blocking verification
    // flags is refused outright. Checked before anything is written, so a
    // refused publish leaves no half-uploaded deck behind. Decks not produced by
    // that pipeline have no provenance record and are unaffected.
    if (metadata.isPublished === true)
    {
        const publishDecision = await PaidDeckPublishGate.evaluate(incomingId);
        if (!publishDecision.allowed)
        {
            response.statusCode = httpStatus.CONFLICT;
            response.sendJson
            ({
                error: publishDecision.reason,
                detail: publishDecision.detail,
                blockingFlags: publishDecision.blockingFlags,
            });
            return;
        }
    }

    const existingDocument = await paidDecksCollection.findOne({ id: incomingId });
    const initialKeyVersion = existingDocument?.keyVersion || 1;
    const nextKeyVersion = existingDocument ? initialKeyVersion + 1 : 1;

    // Store the master copy per-entity (one encrypted doc per card / study
    // material / mock test / deck node) instead of one monolithic blob, so a
    // deck larger than Mongo's 16MB document cap uploads cleanly.
    try
    {
        await KeyManagementService.storePaidDeckMaster(incomingId, nextKeyVersion, deckPayload);
    }
    catch (storeError)
    {
        if (storeError instanceof PaidDeckEntityTooLargeError)
        {
            response.statusCode = httpStatus.PAYLOAD_TOO_LARGE;
            // The upload dialog surfaces `error` directly, so put the
            // human-readable message there; `code` stays machine-readable.
            response.sendJson
            ({
                error: storeError.message,
                code: ErrorCodes.ENTITY_TOO_LARGE,
                entityId: storeError.entityId
            });
            return;
        }
        throw storeError;
    }

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
        // Deck-level license duration default, applied by the pricing engine
        // whenever a region has no override row. A positive durationDays sells a
        // finite rental; isPerpetual sells lifetime access. Leaving both unset
        // means the buyer's grant is refused until the admin configures one.
        durationDays: Number.isInteger(metadata.durationDays) && metadata.durationDays > 0 ? metadata.durationDays : 0,
        isPerpetual: metadata.isPerpetual === true,
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
    // "Date modified" surfaced on the buyer-facing details page — refreshed
    // on every content upload, and also bumped by metadata edits (see
    // UpdatePaidDeck). Distinct from publishedAt so it reflects real changes.
    documentToWrite.updatedAt = new Date();

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

    // Advisory trademark check on the publicly listed fields. A paid deck is the
    // one surface where authored text is shown to every user, so a third-party
    // institute mark in its title, description or tags is published in a
    // commercial context. Reported rather than enforced: naming an exam or
    // institute to describe what the material covers is often legitimate
    // nominative use, and only the operator can tell that from implied
    // endorsement. Silently rewriting an admin's chosen title would be worse
    // than surfacing it.
    const registeredMarksFound = [...new Set([
        ...BrandNameSanitizer.findRegisteredMarks(paidDeckSeed.title),
        ...BrandNameSanitizer.findRegisteredMarks(paidDeckSeed.description),
        ...BrandNameSanitizer.findRegisteredMarks((paidDeckSeed.tags || []).join(" "))
    ])];

    if (registeredMarksFound.length > 0)
    {
        console.warn(`[UploadPaidDeck] Deck ${incomingId} carries third-party mark(s) in publicly listed fields: ${registeredMarksFound.join(", ")}`);
    }

    // Stamp who published this deck and when into its provenance record. Written
    // once and never overwritten, so the record shows the first publication
    // rather than the most recent metadata edit. A deck with no provenance
    // record (not pipeline-generated) is a no-op.
    if (metadata.isPublished === true)
    {
        try
        {
            await GenerationProvenanceQueryEngine.recordPublication(incomingId, request.user?.getId() || null);
        }
        catch (publicationRecordError)
        {
            console.warn(`[UploadPaidDeck] Could not stamp publication into the provenance record: ${publicationRecordError.message}`);
        }
    }

    response.statusCode = httpStatus.OK;
    response.sendJson
    ({
        success: true,
        deckId: incomingId,
        keyVersion: nextKeyVersion,
        contentVersion: documentToWrite.contentSummary.contentVersion,
        trademarkWarnings: registeredMarksFound
    });
}

module.exports = { uploadPaidDeck };
