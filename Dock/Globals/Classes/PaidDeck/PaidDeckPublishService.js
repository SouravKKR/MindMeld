const crypto = require("crypto");
const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const KeyManagementService = require("../Security/KeyManagementService");
const PaidDeckEntityTooLargeError = require("../Security/PaidDeckEntityTooLargeError");
const PaidDeck = require("../../Model/PaidDeck");
const PaidDeckPricing = require("../../Model/PaidDeckPricing");
const PaidDeckContentSummarizer = require("./PaidDeckContentSummarizer");
const PaidDeckPublishGate = require("../Generation/PaidDeckPublishGate");
const PaidDeckProvenanceLinkResolver = require("../Generation/PaidDeckProvenanceLinkResolver");
const GenerationProvenanceQueryEngine = require("../Database/GenerationProvenanceQueryEngine");
const RegionMetadata = require("../Pricing/RegionMetadata");
const BrandNameSanitizer = require("../Content/BrandNameSanitizer");
const PaidDeckAcquisitionGate = require("./PaidDeckAcquisitionGate");
const ErrorCodes = require("../../Constants/ErrorCodes");

/**
 * PaidDeckPublishService
 *
 * The one path by which encrypted deck content becomes a published deck.
 *
 * Two callers reach it: the super-admin catalogue upload, and an organization
 * publishing to its own members. They differ ONLY in the audience and the
 * price, and both of those are decided by the caller's standing rather than by
 * anything in the request — an organization's publish is forced to its own
 * audience and to zero, and cannot express a price or a region override at all.
 *
 * Sharing the path is the point. Master-key versioning, per-entity encryption
 * (so a deck over Mongo's 16MB document cap still uploads), the content-version
 * bump buyers detect updates from, the pipeline review gate and the provenance
 * stamp are the parts that are easy to get subtly wrong, and an organization
 * publish that reimplemented any of them would drift from the catalogue's
 * behaviour without anyone noticing until a member's deck failed to decrypt.
 *
 * Returns a result object rather than writing a response, so the two endpoints
 * can shape their own error bodies.
 */
class PaidDeckPublishService
{
    /**
     * Publishes or re-publishes a deck.
     *
     * @param {object} options
     * @param {object} options.metadata storefront fields from the caller
     * @param {object} options.deckPayload the plaintext deck bundle to encrypt
     * @param {string} options.publisherUserId who is publishing
     * @param {string} options.audienceOrganizationId "" for the public catalogue
     * @param {string[]} options.audienceTags who the deck is suggested to inside that organization
     * @param {boolean} options.allowPricing false for organization publishes, which are always free
     * @returns {Promise<{ success: boolean, statusCode?: number, error?: string, ... }>}
     */
    static async publish(options)
    {
        const metadata = options?.metadata;
        const deckPayload = options?.deckPayload;

        if (!KeyManagementService.isReady())
        {
            return { success: false, error: ErrorCodes.KEY_MANAGEMENT_NOT_READY, reason: "KEY_MANAGEMENT" };
        }

        if (!metadata || !deckPayload)
        {
            return { success: false, error: ErrorCodes.MISSING_METADATA_OR_PAYLOAD, reason: "BAD_REQUEST" };
        }

        const audienceOrganizationId = typeof options.audienceOrganizationId === "string" ? options.audienceOrganizationId : "";
        const bAllowPricing = options.allowPricing !== false && audienceOrganizationId.length === 0;

        const database = await DatabaseConnector.getDatabase();
        const paidDecksCollection = database.collection(DatabaseConstants.PAID_DECKS_COLLECTION);

        const incomingId = metadata.id || crypto.randomUUID();
        const bPublishing = metadata.isPublished === true;

        const existingDocument = await paidDecksCollection.findOne({ id: incomingId });

        // Which deck's generation record governs this listing.
        //
        // This is NOT the listing's own id. A listing id is minted fresh by the
        // upload dialog on every upload, while provenance is recorded against
        // the source deck in the publisher's library (MoveToDatabase stamps it
        // there, because that is the first moment "this run produced that deck"
        // is a known fact). Evaluating the gate against the listing id — which
        // is what this did originally — looked up an id that by construction
        // never appears in the provenance collection, so the lookup always
        // missed, the gate always allowed, and a deck with unresolved blocking
        // flags published cleanly. The link has to be carried explicitly.
        //
        // sourceDeckId is consulted before giving up: a caller that says where the
        // content came from has told us which library deck to look under, even
        // when it did not name a provenance deck. Falling back to incomingId
        // after that keeps listings published before either field existed
        // behaving exactly as they did: no record, nothing to verify.
        //
        // The picked deck is then resolved to the deck the record is actually
        // filed under. A run launched into "Chemistry" files its record against
        // the "Unit I: ..." deck it created, while the tile an administrator
        // picks to sell is "Chemistry" — so the id arriving here is usually a
        // relative of the record's deck rather than the record's deck itself.
        // Resolving now, once, means the gate below and every later read see a
        // link that points straight at the record. When no run matches, this
        // returns the id unchanged and nothing about the old behaviour changes.
        const pickedProvenanceDeckId = metadata.provenanceDeckId
            || existingDocument?.provenanceDeckId
            || metadata.sourceDeckId
            || existingDocument?.sourceDeckId
            || incomingId;

        const provenanceDeckId = await PaidDeckProvenanceLinkResolver.resolveForDeckId(pickedProvenanceDeckId);

        // The pipeline review gate. Refused BEFORE anything is written, so a
        // blocked publish leaves no half-uploaded deck behind. Decks not
        // produced by that pipeline have no provenance record and are
        // unaffected — and an organization publish is gated identically,
        // because "who the audience is" does not change whether the content
        // passed verification.
        if (bPublishing)
        {
            const publishDecision = await PaidDeckPublishGate.evaluate(provenanceDeckId);
            if (!publishDecision.allowed)
            {
                return {
                    success: false,
                    error: publishDecision.reason,
                    reason: "PUBLISH_GATE",
                    detail: publishDecision.detail,
                    blockingFlags: publishDecision.blockingFlags
                };
            }
        }

        // An existing deck can never change hands or audience through an upload.
        // Without this, an organization re-uploading over a catalogue id would
        // pull a public deck into its own audience — or, worse, a second
        // organization could take over the first one's deck by guessing its id.
        if (existingDocument)
        {
            const existingAudience = typeof existingDocument.audienceOrganizationId === "string" ? existingDocument.audienceOrganizationId : "";
            if (existingAudience !== audienceOrganizationId)
            {
                return { success: false, error: ErrorCodes.ACCESS_NOT_ALLOWED, reason: "AUDIENCE_MISMATCH" };
            }

            // Retirement is one-way. Buyers were told this deck was withdrawn,
            // and a listing that can quietly come back under the same id is a
            // promise nobody made — republishing means uploading it as a new
            // deck, which is honest about it being a new offer.
            if (PaidDeckAcquisitionGate.isRetired(existingDocument))
            {
                return { success: false, error: ErrorCodes.PAID_DECK_RETIRED, reason: "RETIRED" };
            }
        }

        const initialKeyVersion = existingDocument?.keyVersion || 1;
        const nextKeyVersion = existingDocument ? initialKeyVersion + 1 : 1;

        // The master copy is stored per entity (one encrypted document per card
        // / study material / mock test / deck node) rather than as one blob, so
        // a deck larger than Mongo's 16MB document cap uploads cleanly.
        try
        {
            await KeyManagementService.storePaidDeckMaster(incomingId, nextKeyVersion, deckPayload);
        }
        catch (storeError)
        {
            if (storeError instanceof PaidDeckEntityTooLargeError)
            {
                return {
                    success: false,
                    error: storeError.message,
                    code: ErrorCodes.ENTITY_TOO_LARGE,
                    reason: "ENTITY_TOO_LARGE",
                    entityId: storeError.entityId
                };
            }
            throw storeError;
        }

        const paidDeckSeed =
        {
            id: incomingId,
            title: metadata.title,
            description: metadata.description || "",
            sellerId: metadata.sellerId || options.publisherUserId || "",
            // Which library deck this listing's content came from, and which
            // deck's generation record governs it. They differ only when a
            // sub-deck is sold individually: provenance lives on the top-level
            // generated deck, so a child carries its own sourceDeckId but its
            // parent's provenanceDeckId. Both fall back to the existing
            // document so a metadata-only re-upload cannot orphan the link.
            sourceDeckId: metadata.sourceDeckId || existingDocument?.sourceDeckId || "",
            provenanceDeckId: provenanceDeckId,
            thumbnailUrl: metadata.thumbnailUrl || "",
            category: metadata.category || "",
            tags: metadata.tags || [],
            // An organization's decks are provided, not sold. Price and licence
            // duration are forced here rather than validated, so a crafted
            // request cannot put a price on one — and because they are forced,
            // no order can ever be created for such a deck and no payment path
            // is reachable from it at all.
            basePriceMinor: bAllowPricing ? (metadata.basePriceMinor || 0) : 0,
            currency: bAllowPricing ? (metadata.currency || "INR") : "INR",
            durationDays: bAllowPricing && Number.isInteger(metadata.durationDays) && metadata.durationDays > 0 ? metadata.durationDays : 0,
            isPerpetual: bAllowPricing ? metadata.isPerpetual === true : true,
            granularity: metadata.granularity || 0,
            bundleChildIds: metadata.bundleChildIds || [],
            parentBundleIds: metadata.parentBundleIds || [],
            assetBlobId: `${incomingId}:${nextKeyVersion}`,
            keyVersion: nextKeyVersion,
            isPublished: bPublishing,
            audienceOrganizationId: audienceOrganizationId,
            audienceTags: PaidDeckPublishService.normaliseAudienceTags(options.audienceTags),
            publishedAt: metadata.publishedAt ? new Date(metadata.publishedAt).toISOString() : new Date().toISOString(),
            additionalData: metadata.additionalData || {}
        };

        const paidDeck = PaidDeck.fromJson(paidDeckSeed);
        const documentToWrite = paidDeck.toJson();
        documentToWrite.lastKeyRotationAt = new Date();
        // "Date modified" on the details page — refreshed on every content
        // upload, and also bumped by metadata edits. Distinct from publishedAt
        // so it reflects real changes.
        documentToWrite.updatedAt = new Date();

        // Storefront metadata that lives only on the paidDecks document: it
        // never enters the encrypted asset and never reaches a member's device.
        documentToWrite.featureBadges = Array.isArray(metadata.featureBadges)
            ? metadata.featureBadges
            : (existingDocument && Array.isArray(existingDocument.featureBadges) ? existingDocument.featureBadges : []);

        documentToWrite.extraTags = Array.isArray(metadata.extraTags)
            ? metadata.extraTags
            : (existingDocument && Array.isArray(existingDocument.extraTags) ? existingDocument.extraTags : []);

        // Recomputed from the payload just uploaded. contentVersion bumps on
        // every content change so existing holders detect an update without
        // conflating it with a periodic key rotation.
        const previousContentVersion = existingDocument?.contentSummary?.contentVersion || 0;
        documentToWrite.contentSummary =
        {
            ...PaidDeckContentSummarizer.summarize(deckPayload),
            contentVersion: previousContentVersion + 1
        };

        await paidDecksCollection.updateOne({ id: incomingId }, { $set: documentToWrite }, { upsert: true });

        if (bAllowPricing)
        {
            await PaidDeckPublishService.upsertRegionalPriceOverrides(database, incomingId, metadata.regionalPrices);
        }

        const registeredMarksFound = PaidDeckPublishService.findRegisteredMarks(paidDeckSeed);
        if (registeredMarksFound.length > 0)
        {
            console.warn(`[PaidDeckPublishService] Deck ${incomingId} carries third-party mark(s) in publicly listed fields: ${registeredMarksFound.join(", ")}`);
        }

        // Stamped once and never overwritten, so the record shows the first
        // publication rather than the most recent metadata edit.
        if (bPublishing)
        {
            try
            {
                await GenerationProvenanceQueryEngine.recordPublication(provenanceDeckId, options.publisherUserId || null);
            }
            catch (publicationRecordError)
            {
                console.warn(`[PaidDeckPublishService] Could not stamp publication into the provenance record: ${publicationRecordError.message}`);
            }
        }

        return {
            success: true,
            deckId: incomingId,
            keyVersion: nextKeyVersion,
            contentVersion: documentToWrite.contentSummary.contentVersion,
            trademarkWarnings: registeredMarksFound,
            bCreated: !existingDocument
        };
    }

    /**
     * Lower-cased, de-duplicated, blank-free. Matches how member tags are
     * normalised, so "Final-Year" on a deck and "final-year" on a member are
     * the same cohort rather than two.
     */
    static normaliseAudienceTags(rawTags)
    {
        if (!Array.isArray(rawTags))
        {
            return [];
        }

        const normalisedTags = rawTags
            .map(tag => String(tag).trim().toLowerCase())
            .filter(tag => tag.length > 0);

        return Array.from(new Set(normalisedTags));
    }

    /**
     * Advisory trademark check on the publicly listed fields. A published deck
     * is the one surface where authored text is shown in a commercial context,
     * so a third-party institute mark in its title, description or tags is
     * reported — but not enforced. Naming an exam to describe what material
     * covers is often legitimate nominative use, and only an operator can tell
     * that from implied endorsement; silently rewriting a chosen title would be
     * worse than surfacing it.
     */
    static findRegisteredMarks(paidDeckSeed)
    {
        return [...new Set([
            ...BrandNameSanitizer.findRegisteredMarks(paidDeckSeed.title),
            ...BrandNameSanitizer.findRegisteredMarks(paidDeckSeed.description),
            ...BrandNameSanitizer.findRegisteredMarks((paidDeckSeed.tags || []).join(" "))
        ])];
    }

    /**
     * Upserts per-region price overrides into the collection
     * PaidDeckPricingEngine reads. The base price stays the canonical default;
     * these rows only override specific regions. Keyed by (deckId, region) so a
     * re-upload replaces a region's price instead of stacking duplicates, and
     * regions the caller did not include are left untouched.
     *
     * Never reached for an organization deck — those have no price to override.
     */
    static async upsertRegionalPriceOverrides(database, deckId, regionalPrices)
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
                // Licence duration is explicit per region: a positive
                // durationDays sells a finite rental, isPerpetual sells lifetime
                // access. A region overriding neither inherits the deck-level
                // default only if that is also blank — otherwise the buyer's
                // grant is refused (see LicenseExpiryResolver).
                durationDays: Number.isInteger(entry.durationDays) && entry.durationDays > 0 ? entry.durationDays : 0,
                isPerpetual: entry.isPerpetual === true,
                effectiveFrom: new Date().toISOString(),
                effectiveUntil: farFutureIso,
                additionalData: {}
            });

            await collection.updateOne({ deckId: deckId, region: region }, { $set: pricing.toJson() }, { upsert: true });
        }
    }
}

module.exports = PaidDeckPublishService;
