const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");
const PaidDeckPricingEngine = require("../../Globals/Classes/Pricing/PaidDeckPricingEngine");
const RegionResolver = require("../../Globals/Classes/Pricing/RegionResolver");
const PaidDeckDeepLinkCookie = require("../Helpers/PaidDeckDeepLinkCookie");
const { getSession } = require("../Helpers/GetSession");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");

/**
 * Returns ONE published storefront listing by ID, enriched exactly as
 * BrowsePaidDeckLibrary enriches the rows it returns — so the object handed to
 * PaidDeckDetailsPage.initialize is indistinguishable from one the library page
 * clicked through with.
 *
 * This exists for the share/QR deep link: a cold load at /PaidDeck?id=<deckId>
 * has no listing in memory, and the search endpoint cannot look one up by ID
 * (its filters are auto-published to the client's filter drawer, so adding an
 * "id" filter there would surface a nonsense UI input).
 *
 * Public, like /PaidDecks/Library and /PaidDecks/Search — a storefront page has
 * to be reachable before anyone owns anything.
 */
async function getPaidDeckDetails(request, response)
{
    const queryParams = await request.getQueryParams();
    const deckId = queryParams.deckId || "";

    // The same predicate the share URL and the deep-link cookie are validated
    // with, so the ID this endpoint accepts can never drift from the ID the QR
    // code encodes.
    if (!PaidDeckDeepLinkCookie.isValidDeckId(deckId))
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_DECK_ID });
        return;
    }

    // This route carries no ensureLogin plugin, so request.session is never
    // populated on it. Resolving the session explicitly is what lets a
    // signed-in owner see ALREADY_OWNED pricing here instead of the anonymous
    // region price. (/PaidDecks/Library and /PaidDecks/Search read
    // request.session directly and therefore always price anonymously — a
    // pre-existing quirk this endpoint deliberately does not inherit.)
    const session = await getSession(request);
    const userId = session ? session.getUserId() : null;

    const region = RegionResolver.resolveRegion(request, (queryParams.region || "").toUpperCase() || null, (queryParams.localeRegionHint || "").toUpperCase() || null);

    const database = await DatabaseConnector.getDatabase();

    // isPublished is part of the QUERY, not a check on the loaded document, so
    // an unpublished draft is never read into memory on a public route.
    const deckDocument = await database
        .collection(DatabaseConstants.PAID_DECKS_COLLECTION)
        .findOne({ id: deckId, isPublished: true });

    if (!deckDocument)
    {
        // Deliberately the same response for "no such deck" and "exists but is
        // still a draft". Distinguishing them would turn this endpoint into an
        // enumeration oracle for unpublished deck IDs.
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ error: ErrorCodes.PAID_DECK_NOT_FOUND });
        return;
    }

    const pricing = await PaidDeckPricingEngine.computeFinalPrice
    (
        userId,
        [deckDocument.id],
        region,
        undefined,
        true
    );

    const deckPayload = { ...deckDocument };
    delete deckPayload._id;
    deckPayload.computedPrice = pricing.breakdown[0] || null;
    deckPayload.currency = pricing.currency;

    response.statusCode = httpStatus.OK;
    response.sendJson
    ({
        region: region,
        deck: deckPayload
    });
}

module.exports = { getPaidDeckDetails };
