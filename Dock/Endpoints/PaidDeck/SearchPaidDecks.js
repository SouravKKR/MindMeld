const PaidDeckSearchEngine = require("../../Globals/Classes/Search/PaidDeckSearchEngine");

async function searchPaidDecks(request, response)
{
    const session = request.session;
    const userId = session ? session.getUserId() : null;
    const body = await request.getBody();

    const searchResult = await PaidDeckSearchEngine.search
    ({
        filters: body?.filters || {},
        sort: body?.sort || null,
        region: body?.region || "IN",
        limit: body?.limit,
        offset: body?.offset,
        userId: userId,
        includeUnpublished: false
    });

    response.statusCode = 200;
    response.sendJson(searchResult);
}

module.exports = { searchPaidDecks };
