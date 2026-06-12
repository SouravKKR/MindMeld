const CreditConfigurationStore = require("../../Globals/Classes/Credits/CreditConfigurationStore");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");

/**
 * GET /Admin/Credits/Config
 *
 * Returns the singleton credit configuration, seeding safe defaults on the
 * first ever read so the admin editor always has a document to render.
 */
async function getCreditConfig(request, response)
{
    try
    {
        const configuration = await CreditConfigurationStore.load();
        response.statusCode = httpStatus.OK;
        response.sendJson({ config: configuration.toJson() });
    }
    catch (loadError)
    {
        console.error(`[GetCreditConfig] ${loadError.message}`);
        response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
        response.sendJson({ error: "FAILED_TO_LOAD_CREDIT_CONFIG" });
    }
}

module.exports = { getCreditConfig };
