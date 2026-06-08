const PaidDeckSearchEngine = require("../../Globals/Classes/Search/PaidDeckSearchEngine");
const RegionResolver = require("../../Globals/Classes/Pricing/RegionResolver");

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
        includeUnpublished: false
    });

    response.statusCode = 200;
    response.sendJson(searchResult);
}

module.exports = { searchPaidDecks };
