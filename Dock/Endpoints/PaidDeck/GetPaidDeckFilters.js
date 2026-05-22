const PaidDeckSearchEngine = require("../../Globals/Classes/Search/PaidDeckSearchEngine");

async function getPaidDeckFilters(request, response)
{
    const filterMetadataList = await PaidDeckSearchEngine.listFilterMetadata();

    response.statusCode = 200;
    response.sendJson({ filters: filterMetadataList });
}

module.exports = { getPaidDeckFilters };
