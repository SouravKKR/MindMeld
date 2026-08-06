const PaidDeckSearchEngine = require("../../Globals/Classes/Search/PaidDeckSearchEngine");
const RegionResolver = require("../../Globals/Classes/Pricing/RegionResolver");
const PaidDeckAudienceResolver = require("../../Globals/Classes/PaidDeck/PaidDeckAudienceResolver");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");

async function searchPaidDecks(request, response)
{
    const session = request.session;
    const userId = session ? session.getUserId() : null;
    const body = await request.getBody();

    // Resolve the buyer region (manual override -> CF-IPCountry header ->
    // browser locale hint -> default) so prices are shown/converted into the
    // right currency.
    const region = RegionResolver.resolveRegion(request, body?.region || null, body?.localeRegionHint || null);

    const searchResult = await PaidDeckSearchEngine.search
    ({
        filters: body?.filters || {},
        sort: body?.sort || null,
        region: region,
        limit: body?.limit,
        offset: body?.offset,
        userId: userId,
        includeUnpublished: false,
        // Server-composed and $and-ed into the query, never derived from the
        // body: an audience the client could name would be no audience at all.
        audienceCondition: await PaidDeckAudienceResolver.buildVisibilityCondition(await PaidDeckAudienceResolver.resolveAudienceUser(request))
    });

    response.statusCode = httpStatus.OK;
    response.sendJson(searchResult);
}

module.exports = { searchPaidDecks };
