const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");
const PaidDeckPricingEngine = require("../../Globals/Classes/Pricing/PaidDeckPricingEngine");
const RegionResolver = require("../../Globals/Classes/Pricing/RegionResolver");
const PaidDeckAudienceResolver = require("../../Globals/Classes/PaidDeck/PaidDeckAudienceResolver");
const PaidDeckStorefrontProjection = require("../../Globals/Classes/PaidDeck/PaidDeckStorefrontProjection");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");

async function browsePaidDeckLibrary(request, response)
{
    const session = request.session;
    const userId = session ? session.getUserId() : null;
    const queryParams = await request.getQueryParams();
    const region = RegionResolver.resolveRegion(request, (queryParams.region || "").toUpperCase() || null, (queryParams.localeRegionHint || "").toUpperCase() || null);
    const category = queryParams.category || null;
    const limit = Math.min(parseInt(queryParams.limit || "50", 10) || 50, 200);
    const offset = parseInt(queryParams.offset || "0", 10) || 0;

    const database = await DatabaseConnector.getDatabase();
    const filter = { isPublished: true };

    if (category)
    {
        filter.category = category;
    }

    // Restrict the listing to decks this caller is an audience for. An
    // organization's decks belong to its members and to nobody else, so this
    // clause is what keeps one institute's material out of another's students'
    // catalogue. It fails closed: an unidentifiable caller is treated as the
    // public and sees the public catalogue only.
    const visibilityCondition = await PaidDeckAudienceResolver.buildVisibilityCondition(await PaidDeckAudienceResolver.resolveAudienceUser(request));
    if (visibilityCondition)
    {
        Object.assign(filter, visibilityCondition);
    }

    const deckDocuments = await database
        .collection(DatabaseConstants.PAID_DECKS_COLLECTION)
        .find(filter)
        .sort({ publishedAt: -1 })
        .skip(offset)
        .limit(limit)
        .toArray();

    const enrichedDecks = [];

    for (const deckDocument of deckDocuments)
    {
        const pricing = await PaidDeckPricingEngine.computeFinalPrice
        (
            userId,
            [deckDocument.id],
            region,
            undefined,
            true
        );

        const deckPayload = PaidDeckStorefrontProjection.forBuyer(deckDocument);
        delete deckPayload._id;
        deckPayload.computedPrice = pricing.breakdown[0] || null;
        deckPayload.currency = pricing.currency;

        enrichedDecks.push(deckPayload);
    }

    response.statusCode = httpStatus.OK;
    response.sendJson
    ({
        region: region,
        decks: enrichedDecks,
        offset: offset,
        limit: limit
    });
}

module.exports = { browsePaidDeckLibrary };
