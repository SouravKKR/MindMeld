const PaidDeckSearchEngine = require("../../Globals/Classes/Search/PaidDeckSearchEngine");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");

async function getPaidDeckFilters(request, response)
{
    const filterMetadataList = await PaidDeckSearchEngine.listFilterMetadata();

    response.statusCode = httpStatus.OK;
    response.sendJson({ filters: filterMetadataList });
}

module.exports = { getPaidDeckFilters };
